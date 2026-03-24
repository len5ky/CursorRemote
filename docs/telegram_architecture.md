# Telegram Transport — Architecture Document

## 1. Component Overview

```
┌───────────────────────────────────────────────────────────┐
│                    TelegramTransport                       │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ TopicManager │  │ MessageTracker│  │   Formatter     │  │
│  │              │  │              │  │                 │  │
│  │ threadId ↔   │  │ elementId →  │  │ ChatElement →   │  │
│  │ window+tab   │  │ msgId[]      │  │ Telegram HTML   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘  │
│         │                 │                    │           │
│  ┌──────▼─────────────────▼────────────────────▼────────┐  │
│  │              Bot (grammy)                            │  │
│  │                                                      │  │
│  │  Commands: /topics /mode /model /status              │  │
│  │  Callbacks: approve, reject, run, skip, build, etc.  │  │
│  │  Text: forwarded as sendMessage to Cursor            │  │
│  │  Typing: sendChatAction loop while agent active      │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                           │
└────────────────────────┬──────────────────────────────────┘
                         │
            subscribes to│ calls
                         │
         ┌───────────────▼───────────────┐
         │         Core System           │
         │                               │
         │  StateManager  (events)       │
         │  CommandExecutor  (methods)   │
         │  CDPBridge  (switchWindow)    │
         └───────────────────────────────┘
```

## 2. Module Structure

```
src/server/transports/telegram/
├── index.ts            # TelegramTransport class - lifecycle, event wiring
├── formatter.ts        # ChatElement → Telegram HTML conversion
├── commands.ts         # Bot command handlers + callback query handlers
├── topic-manager.ts    # Topic ↔ window+tab bidirectional mapping
└── message-tracker.ts  # ChatElement.id → Telegram message_id tracking
```

## 3. Data Flow

### 3.1 Outbound: Cursor → Telegram

```
StateManager emits 'state:patch'
  │
  ▼
TelegramTransport.onStatePatch(patch)
  │
  ├─ patch.messages? → diffMessages(oldMessages, newMessages)
  │   │
  │   ├─ New element → formatter.format(element) → bot.sendMessage(chatId, html, { thread_id, reply_markup })
  │   │                                          → messageTracker.track(elementId, telegramMsgId, threadId)
  │   │
  │   ├─ Changed element → formatter.format(element) → bot.editMessageText(chatId, msgId, html, { reply_markup })
  │   │
  │   └─ Removed element → (no action, Telegram messages persist)
  │
  ├─ patch.pendingApprovals? → sendOrUpdateApprovalMessage(threadId, approvals)
  │
  ├─ patch.agentStatus? → updateTypingIndicator(status)
  │
  ├─ patch.mode? / patch.model? → (no automatic push, shown on /mode /model commands)
  │
  └─ patch.chatTabs? / patch.windows? → (no automatic push, shown on /topics /status)
```

**Window snapshots**: In production, `WindowMonitor` fires `window:update` → `TelegramTransport.processWindow` → `doProcessWindow` for each connected window. That path sends **ephemeral activity** (with thought dedup), **composer queue** summary, and **content messages** using the same `formatter` + `MessageTracker` as above — not only `state:patch`.

### 3.2 Inbound: Telegram → Cursor

```
User sends text in topic
  │
  ▼
Bot middleware: check allowlist → reject if unauthorized
  │
  ▼
topicManager.resolveThread(threadId)
  │
  ├─ Returns { windowId, tabTitle }
  │
  ├─ If windowId !== activeWindowId → cdpBridge.switchWindow(windowId) → wait for 'connected'
  │
  ├─ If tabTitle !== activeTab → commandExecutor.switchTab(tabTitle) → wait
  │
  └─ commandExecutor.sendMessage(text) → reply with confirmation or error
```

```
User taps inline keyboard button
  │
  ▼
Bot callback_query handler
  │
  ├─ Parse callback data: "{action}:{shortId}:{selectorHash}"
  │
  ├─ Look up full selectorPath from hash map
  │
  ├─ Route by action:
  │   ├─ approve / reject / approve_all → commandExecutor.clickApproval(selectorPath)
  │   ├─ run / skip / allow → commandExecutor.clickAction(selectorPath)
  │   ├─ build / view_plan → commandExecutor.clickAction(selectorPath)
  │   ├─ set_mode:{modeId} → commandExecutor.setMode(modeId)
  │   └─ set_model:{modelId} → commandExecutor.setModel(modelId)
  │
  └─ Answer callback query with result text
```

## 4. Component Details

### 4.1 TelegramTransport (`index.ts`)

The main class that implements the `Transport` interface.

**Constructor** receives: `TelegramConfig`, `StateManager`, `CommandExecutor`, `CDPBridge`

**Lifecycle**:
- `start()`: Create grammy `Bot` with auto-retry plugin, register middleware (allowlist), register commands and callback handlers, subscribe to StateManager events, start long polling
- `stop()`: Stop long polling, unsubscribe from StateManager events

**Rate limiting**:
- `@grammyjs/auto-retry` plugin on the bot: catches 429 responses, waits `retry_after`, retries up to 3 times (max 60s delay)
- `SendQueue` class (configured in `TelegramTransport`): serializes outbound `sendMessage` / `editMessageText` with **~300ms** between sends and **100ms** between edits (see `send-queue.ts` defaults vs. transport override)
- `seenThreads` set: on first encounter with a thread, only last 5 messages are sent (older ones marked as "skipped" in tracker)

**Activity messages** (ephemeral status line):

- On each window snapshot, `doProcessWindow` compares `snapshot.agentActivityText` to tracked state per `threadId`, but only when `snapshot.agentActivityLive` is true.
- If activity is **redundant** with a matching in-progress `step_summary` thought in recent messages, any existing activity Telegram message is **deleted** and no new one is sent (`activityRedundantWithInProgressStepSummary` in `formatter.ts`).
- Otherwise: send → edit on label change → delete when live activity clears; `cleanStaleActivity()` removes stuck rows after `AGENT_ACTIVITY_STALE_MS` (`src/server/activity-stale.ts`, 30s). The same timeout clears the web header via `StateManager`.
- Persists activity `message_id` map to `data/telegram-activity.json` so restarts can clean orphaned messages.

**State subscription**:
- `stateManager.on('state:patch', this.onStatePatch)`
- `stateManager.on('connection:changed', this.onConnectionChanged)`

**Typing loop**:
- When `agentActivityLive` is true and `agentStatus` is `thinking`, `generating`, or `running_tool`, a `setInterval` calls `sendChatAction('typing')` every 4 seconds to the active topic
- The interval is cleared as soon as live activity drops, even if a stale status label remains in Cursor's DOM
- Typing actions bypass the SendQueue (cheap and non-critical)

### 4.2 Formatter (`formatter.ts`)

Pure functions that convert `ChatElement` objects to Telegram HTML strings and optional `InlineKeyboard` objects.

**Key functions**:
- `formatElement(element: ChatElement): { html: string; keyboard?: InlineKeyboard }` — dispatch by element type
- `formatAssistant(msg: AssistantMessage): string` — convert Cursor HTML to Telegram HTML, passes `msg.codeBlocks` for accurate code rendering
- `formatActivity(text: string): string` — ephemeral activity line (`● label…`), no spoiler tag
- `thoughtAppearsInProgress(msg: ThoughtBlock): boolean` — exported; used for activity dedup and thought formatting
- `activityRedundantWithInProgressStepSummary(activityText, elements): boolean` — suppresses duplicate activity vs. `📎` step-summary thoughts
- `formatPlan(plan: PlanBlock): { html: string; keyboard: InlineKeyboard }` — full plan card with todo list
- `formatRunCommand(cmd: RunCommand): { html: string; keyboard: InlineKeyboard }` — command card with buttons
- `formatApprovals(approvals: Approval[]): { html: string; keyboard: InlineKeyboard }` — approval message with buttons
- `splitMessage(html: string, limit?: number): string[]` — split at paragraph/code boundaries

**HTML conversion** (`cursorHtmlToTelegram`):

Uses `node-html-parser` to parse Cursor's HTML into a DOM tree, then recursively walks it to produce Telegram-safe HTML. This replaced the original regex approach, which could not handle Cursor's complex nested structures (Shiki code blocks with per-line divs, class-based bold spans, tables).

Key conversions:
- Composer code blocks (`composer-message-codeblock`, `composer-code-block-container`) → `<pre><code>` using structured **`codeBlocks`** (`CodeBlockItem`: joined `code` or diff lines with `+`/`-` prefixes), falling back to walking `.ui-default-code__line-content` / Monaco line elements when needed
- Headings (`<h1>`–`<h6>`) → `<b>text</b>` with newline boundaries
- Bold spans (`<span class="font-semibold">`, `data-streamdown="strong"`) → `<b>`
- Paragraphs (`<p>`) → content with line breaks
- Tables → pipe-separated rows with bold headers
- Lists (`<ul>/<ol>`) → `•` / `1.` prefixed lines, inner `<p>` unwrapped
- Preserves `<code>`, `<pre>`, `<a href>`, `<blockquote>`, `<b>`, `<i>`, `<u>`, `<s>`
- Skips non-content elements (buttons, scrollbars, copy overlays, cursor icons)
- Skips whitespace-only text nodes to prevent source HTML indentation leaking through
- Escapes `<`, `>`, `&` in text nodes
- Collapses runs of 3+ newlines to double newlines

### 4.3 TopicManager (`topic-manager.ts`)

Manages the bidirectional mapping between Telegram forum topic thread IDs and Cursor window+tab pairs.

**State**:
- `byKey: Map<string, TopicMapping>` — key is `{windowTitle}::{tabTitle}`
- `byThread: Map<number, TopicMapping>` — reverse lookup by threadId

**Methods**:
- `createTopics(bot, chatId, windows, chatTabs)` — create missing topics, return mapping
- `resolveThread(threadId): TopicMapping | undefined` — look up window+tab for a thread
- `getThreadForKey(windowTitle, tabTitle): number | undefined` — look up thread for a window+tab
- `getActiveThread(state): number | undefined` — get the thread for the currently active window+tab

**Persistence** (optional):
- Save mapping to `telegram-topics.json` on changes
- Load on startup to survive restarts

### 4.4 MessageTracker (`message-tracker.ts`)

Tracks the relationship between `ChatElement.id` and Telegram message IDs within each topic.

**State**:
- `messages: Map<string, TrackedMessage>` where key is `{threadId}:{elementId}`

```typescript
interface TrackedMessage {
  telegramMsgIds: number[];  // Multiple if message was split
  threadId: number;
  elementId: string;
  lastContent: string;       // Hash of last sent content for change detection
  type: string;              // ChatElement type for formatting decisions
}
```

**Methods**:
- `getTracked(threadId, elementId): TrackedMessage | undefined`
- `track(threadId, elementId, msgIds, contentHash, type): void`
- `clearThread(threadId): void` — clear all tracked messages for a topic (on chat reset)
- `hasChanged(threadId, elementId, newContentHash): boolean`

### 4.5 Commands (`commands.ts`)

Registers bot command and callback query handlers.

**Command handlers** (each receives `ctx` and the shared state/executor references):

- `/topics` — cycles through all windows (CDP switch + 1.5s wait per window), discovers tabs, creates forum topics with 1.5s pacing between `createForumTopic` calls. Checks for supergroup, admin status, and forum mode before proceeding.
- `/status` — reads `stateManager.getCurrentState()`, formats and replies
- `/history` — formats all messages in current state using `formatElement`, joins with separators, splits at 4096-char boundaries, sends with 1.5s pacing between each chunk
- `/mode` — shows current mode, inline keyboard with available modes
- `/model` — shows current model, inline keyboard (uses state's model info)
- `/plan <text>` — switches to plan mode then sends text
- `/agent <text>` — switches to agent mode then sends text

**Callback query handler**:
- Parses `callbackData` to determine action type
- Routes to appropriate CommandExecutor method
- Answers the callback query with a confirmation or error

## 5. Callback Data Encoding

Telegram limits `callback_data` to 64 bytes. Our encoding scheme:

```
{action}:{shortId}:{hash}
```

- `action`: short string like `apr`, `rej`, `all`, `run`, `skp`, `alw`, `bld`, `vpl`, `mode`, `mdl`
- `shortId`: first 8 chars of the element/approval ID
- `hash`: first 8 chars of a hash of the selector path

A `Map<string, string>` stores `hash → selectorPath`. The map is updated whenever new actions are sent and cleaned up when actions are no longer present in the state.

Examples:
- `apr:abc12345:f7e3a1b2` — approve action
- `run:tool1234:9c8d7e6f` — run command
- `mode:agent` — switch to agent mode (no hash needed)
- `mdl:claude-4-opus` — switch to model (truncated to fit)

## 6. Message Lifecycle

### 6.1 New Element Appears

1. Formatter converts element to HTML + optional keyboard
2. If HTML > 4096 chars, split into parts
3. Send each part via `bot.api.sendMessage(chatId, html, { message_thread_id, parse_mode: 'HTML', reply_markup })`
4. Track all returned message IDs in MessageTracker

### 6.2 Element Content Changes (Streaming)

1. Compute content hash of new element
2. If hash matches tracked hash, skip (no change)
3. If changed, re-format and call `bot.api.editMessageText(chatId, msgId, html, { parse_mode: 'HTML', reply_markup })`
4. If the message was split and new content fits in fewer parts, edit existing parts (leave extras as-is)
5. If new content needs more parts, edit existing parts and send additional messages
6. Update tracked content hash

### 6.3 Approval Resolved

1. On next state patch, `pendingApprovals` is empty
2. Edit the approval message to show "Resolved" (or remove the inline keyboard)
3. Clean up callback data hash map entries for the resolved approval

## 7. Error Recovery

### 7.1 Telegram API Errors

- **Rate limit (429)**: grammy handles this automatically with retry-after
- **Message not found (400)**: Remove from tracker, send new message on next update
- **Chat not found (400)**: Log error, skip this topic until `/topics` re-run
- **Network error**: grammy's long polling auto-reconnects

### 7.2 CDP Disconnection

When `connection:changed` fires with `false`:
- Send a status message to the active topic: "⚠️ Disconnected from Cursor IDE"
- Stop typing indicator
- When reconnected, send: "✅ Reconnected to Cursor IDE"

### 7.3 Bot Restart

- TopicManager loads mapping from `telegram-topics.json` if it exists
- MessageTracker starts empty — no editing of old messages
- Existing topics are re-discovered by matching names
- New messages flow normally from the next state patch

## 8. Dependencies

| Package | Purpose |
|---------|---------|
| `grammy` | Telegram Bot API framework (TypeScript, Bot API 9.5) |
| `node-html-parser` | DOM-based HTML parsing for Cursor HTML → Telegram HTML conversion |

grammy handles long polling, rate limiting, and type-safe API calls. `node-html-parser` provides a lightweight (~40KB, zero sub-dependencies) DOM API (`querySelector`, `textContent`, `classList`) for converting Cursor's deeply nested HTML structures (Shiki code blocks, class-based styling, tables) into Telegram-safe HTML.
