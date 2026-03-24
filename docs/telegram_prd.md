# Telegram Transport Module — Product Requirements Document

## 1. Overview

The Telegram transport module bridges CursorRemote to a Telegram supergroup with forum topics. Each topic maps to a project + chat tab combination, providing a persistent, mobile-friendly interface for monitoring and controlling Cursor agents. The module subscribes to the same `StateManager` events as the web client and routes commands through the same `CommandExecutor`, making it a parallel transport rather than a separate system.

### 1.1 Problem Statement

The web client requires a browser and only works when the tab is open. Telegram is always-on, delivers push notifications natively, and works across all devices without setup. Developers already live in Telegram — having agent conversations appear there removes friction.

### 1.2 Goal

- Stream Cursor agent conversations into Telegram forum topics with proper formatting
- Provide inline keyboard buttons for approvals, plan actions, and command execution
- Support bot commands for mode/model switching, status checks, and topic management
- Accept text input from Telegram and forward it to the Cursor agent
- Show typing indicators while the agent is active
- Token-based registration (`/register <token>`) with optional hardcoded user override
- Auto-create topics for new chat tabs without manual commands

### 1.3 Non-Goals
- Webhook mode (long polling only for simplicity — no public endpoint needed)
- Media/image extraction from Cursor
- Telegram inline mode or private chat support (group-only)

---

## 2. User Stories

### TG-1: Topic-Based Monitoring
**As a** developer using Telegram,
**I want** each Cursor project + chat tab to have its own forum topic in my Telegram group,
**so that** conversations are organized and I can follow specific agents.

### TG-2: Live Chat Streaming
**As a** developer,
**I want** the active agent conversation to stream into its Telegram topic in real time — with formatted assistant messages, tool call summaries, plan widgets, and run commands,
**so that** I can follow the agent's progress from Telegram.

### TG-3: Approval via Inline Buttons
**As a** developer,
**I want** to see pending approvals as Telegram messages with [Accept] [Reject] [Accept All] inline buttons,
**so that** I can approve or reject tool calls without leaving Telegram.

### TG-4: Run Command Approval
**As a** developer,
**I want** to see the full shell command the agent wants to run (with description and command text) and tap [Run] [Skip] or [Allow] inline buttons,
**so that** I can make informed decisions about command execution.

### TG-5: Plan Widget Interaction
**As a** developer,
**I want** to see the plan title, description, and full todo list with status indicators, and tap [Build] or [View Plan] inline buttons,
**so that** I can review and execute plans from Telegram.

### TG-6: Send Messages
**As a** developer,
**I want** to type text in a Telegram topic and have it sent as a prompt to the mapped Cursor agent,
**so that** I can direct the agent from Telegram.

### TG-7: Mode and Model Switching
**As a** developer,
**I want** to run `/mode` and `/model` commands that show the current state and offer inline keyboard buttons to switch,
**so that** I can adjust the agent's behavior from Telegram.

### TG-8: Auto-Sync
**As a** developer,
**I want** to run `/sync` once to enable auto-sync, after which new chat tabs automatically get topics created,
**so that** I never need to manually manage topics.

### TG-9: Status Check
**As a** developer,
**I want** to run `/status` to see connection state, agent status, active window, and active tab at a glance,
**so that** I know the system's health.

### TG-10: Typing Indicator
**As a** developer,
**I want** to see the bot's typing indicator while the agent is thinking, generating, or running a tool,
**so that** I know the agent is active without checking message content.

---

## 3. Message Format Specification

All messages use Telegram's HTML parse mode. Telegram supports: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href="">`, `<blockquote>`, `<tg-spoiler>`.

### 3.1 Human Message

```html
<b>You:</b> the user's prompt text
<i>@file.ts @terminal</i>
```

Mentions are appended as italic text if present.

### 3.2 Assistant Message

Cursor's HTML is converted to Telegram-safe HTML using `node-html-parser` DOM tree walking (not regex). The converter handles Cursor's complex nested HTML structures:

- `<strong>` / `<b>` → `<b>`
- `<em>` / `<i>` → `<i>`
- `<span class="font-semibold">` / `data-streamdown="strong"` → `<b>` (Cursor uses class-based bold)
- `<h1>`–`<h6>` → `<b>heading text</b>` with newline boundaries
- `<p>` → content with paragraph breaks
- `<code>` → `<code>` (preserved)
- `<pre>` with language → `<pre><code class="language-X">`
- `<div class="composer-message-codeblock">` / `composer-code-block-container` (composer code + diff widgets) → `<pre><code>` using structured **`codeBlocks`** (`CodeBlockItem`: plain `code` or diff lines with `+`/`-` prefixes) or, when needed, walking `.ui-default-code__line-content` / Monaco `.view-line` text
- `<table>` with `<th>`/`<td>` → pipe-separated rows with bold headers
- `<a href>` → `<a href>`
- `<blockquote>` → `<blockquote>`
- `<ul>` → `•` prefixed lines, `<ol>` → numbered lines (inner `<p>` tags unwrapped)
- Non-content elements (buttons, scrollbars, copy overlays) → skipped
- Whitespace-only text nodes → skipped (prevents source HTML indentation leaking through)

Messages exceeding 4096 characters are split at paragraph or code block boundaries. Each part is sent as a separate Telegram message. All message IDs are tracked for the element.

Assistant messages are edited in-place as content streams in (~800ms update cycle).

### 3.3 Tool Call

```
✓ Read src/server/types.ts
```
or
```
● Edit relay.ts  (+15 -3)
```

Status icon: `✓` for completed, `●` for loading. File stats shown when available. Multiple consecutive tool calls may be batched into a single message.

### 3.4 Thought Block

```html
<i>💭 Thought for 4s</i>
```

### 3.5 Plan Widget

```html
<b>📋 Telegram Integration Module</b>
<i>telegram_integration_module.plan.md</i>

Design and implement a Telegram bot transport...

<b>To-dos (3/10):</b>
✅ Write docs/telegram_prd.md
✅ Write docs/telegram_architecture.md
🔵 Add PlanWidget and RunCommand types
⚪ Update web client
⚪ Create Transport interface
<i>... 5 more</i>

Model: Opus 4.6
```

Inline keyboard: `[▶ Build] [📄 View Plan]`

"View Plan" sends the plan's description as a separate message in the topic.

### 3.6 Run Command

```html
<b>🖥 Run outside sandbox:</b> cd, source, npx, python3

<pre>$ cd /home/user/project && npx convex run ...</pre>
```

Inline keyboard: `[▶ Run] [⏭ Skip]` (and `[🔓 Allow]` when present)

### 3.7 Loading Indicator

While a loading indicator is present, the bot sends `sendChatAction('typing')` every 4 seconds. No message is sent for the loading indicator itself.

### 3.8 Approval (from pendingApprovals)

```
⚠️ Approval needed: Accept
```

Inline keyboard: `[✅ Accept] [❌ Reject] [✅ Accept All]`

Buttons are generated from `approval.actions`. Only shown actions appear as buttons.

### 3.9 Todo List Widget

```html
<b>📝 To-dos (4/10):</b>
✅ BC: Disable Search Partners, keep Display ON
✅ CRM: Disable Display Network
🔵 CRM: Add negative keywords
⚪ CRM: Mark 26 unreviewed search queries
⚪ Update adjustments logs for both campaigns
```

The standalone todo list widget (`.todo-list-container`) is extracted separately from the plan widget. Status icons: `✅` completed, `🔵` in progress, `⚪` pending. No inline keyboard — todo lists are informational only.

### 3.10 Ephemeral activity indicator

While the agent is busy, the transport may show a **short status line** in the topic (from the shared live-activity contract: `agentActivityText` + `agentActivityLive`), separate from synced chat messages:

- **Format**: Italic line `● {label}…` via `formatActivity()` in `formatter.ts`. It does **not** use `<tg-spoiler>` (spoilers are reserved for in-progress **thought** lines where hiding detail is intentional).
- **Lifecycle**: Sent when activity text first appears; **edited** when the label changes; **deleted** when activity clears or goes stale. Message IDs are tracked per forum thread (`activityMsgIds`, persisted in `data/telegram-activity.json` for cleanup).
- **Typing**: Independently, `sendChatAction('typing')` is refreshed on an interval while `agentActivityLive` is true (and status is an active mode), so stale status text alone cannot keep Telegram typing alive.
- **Dedup against thoughts**: If recent `ChatElement`s already include an in-flight **`step_summary` thought** whose title matches the activity label (`📎` formatted line), the bot **suppresses** the ephemeral activity line and **deletes** any existing activity message for that topic. This avoids two parallel lines (e.g. both “Exploring…”) with redundant spoilers. Implemented by `activityRedundantWithInProgressStepSummary()` using exported `thoughtAppearsInProgress()`.

Stale activity rows are also removed on a timer if timestamps stop updating (`AGENT_ACTIVITY_STALE_MS` in `activity-stale.ts`, used by Telegram and `StateManager` for the web UI).

---

## 4. Command Reference

The bot uses token-based authentication. On first startup, a registration token is generated and printed to the server console. Users run `/register <token>` to authenticate. Optionally, `TELEGRAM_ALLOWED_USERS` in `.env` hardcodes allowed user IDs (overrides token auth).

| Command | Arguments | Behavior |
|---------|-----------|----------|
| `/register` | `<token>` | Register yourself with the token from the server console. Stores username and ID. |
| `/sync` | — | Enable auto-sync for this forum group. Creates topics for active tabs with last 5 messages. New tabs auto-create topics. |
| `/sync_all` | — | Create topics for ALL tabs in all windows (not just active ones). Requires /sync first. |
| `/unsync` | — | Disable sync, delete tracked topics, clear all state. |
| `/cleanup` | — | Delete untracked/stale topics, keep active synced ones. |
| `/purge` | — | Delete ALL forum topics (nuclear reset, runs in background). |
| `/status` | — | Show sync state, group ID, connection, agent status, mode, model |
| `/history` | `[count]` | Send last N messages (default 30) of the active conversation. |
| `/mode` | — | Show current mode with inline keyboard to switch (Agent/Ask/Plan/Debug) |
| `/model` | — | Show current model with inline keyboard to switch |
| `/plan` | `<text>` | Switch to Plan mode and send the text as a prompt |
| `/agent` | `<text>` | Switch to Agent mode and send the text as a prompt |

Plain text sent in a topic is forwarded as a message to the Cursor agent mapped to that topic.

---

## 5. Topic Mapping

### 5.1 Structure

The Telegram group is a supergroup with forum topics enabled. Each topic represents one `window + chat tab` combination.

Topic name format: `{project} — {tab title}`

Example topics:
- `cursor-ide-remote — Fix message sending`
- `adwords-agent — Setup CI pipeline`

### 5.2 Mapping Storage

In-memory `Map<string, TopicMapping>` keyed by `{windowTitle}::{tabTitle}`:

```typescript
interface TopicMapping {
  threadId: number;       // Telegram forum topic thread ID
  windowId: string;       // CDP window target ID
  windowTitle: string;    // Project name
  tabTitle: string;       // Chat tab title
  lastActive: number;     // Timestamp of last update
}
```

### 5.3 Topic Lifecycle

1. User runs `/sync` in a forum group → bot validates (supergroup, forum, admin permissions)
2. Bot sets the group ID and enables auto-sync (persisted to `data/telegram-sync.json`)
3. For each currently discovered window+tab pair, creates a topic if it doesn't exist
4. From this point, the WindowMonitor detects new tabs during its 10s cycle and auto-creates topics
5. Mappings persisted to `data/telegram-topics.json` with a high water mark for purge operations

### 5.4 Active Topic Resolution

When the bot receives a message in a topic:
1. Look up the topic's `threadId` in the mapping to find `windowTitle` + `tabTitle`
2. Find the window by title (case-insensitive) in the current window list, refreshing if needed
3. If the window is not the active one, switch the main CDP connection to it
4. If the tab is not the active one, call `commandExecutor.switchTab(tabTitle)`
5. Send the message via `commandExecutor.sendMessage(text)`

---

## 6. Access Control

**Token-based auth (default):**
- On first startup, a 32-char registration token is generated and saved to `data/telegram-auth.json`
- Token is printed to the server console on every startup
- Users run `/register <token>` to authenticate. Username and first name are stored.
- Registered users are persisted across restarts

**Hardcoded override (optional):**
- Set `TELEGRAM_ALLOWED_USERS=123456789,987654321` in `.env`
- When set, this **overrides** token auth — only listed IDs are allowed
- Remove the variable to return to token-based auth

**General:**
- Bot middleware checks `ctx.from?.id` against the registered set for every update (except `/register`)
- Unauthorized users are silently ignored
- The bot must be group admin with privacy mode OFF to receive all messages

---

## 7. Rate Limiting and Constraints

### 7.1 Telegram API Limits

| Constraint | Limit | Our Usage |
|-----------|-------|-----------|
| Message send rate (per chat) | ~20/min | Send queue paces at ~300ms between sends (transport override). Safe. |
| Message edit rate (per message) | ~30/sec | Edit queue paces at 100ms between edits. Safe. |
| Message text length | 4096 chars | Split long messages at paragraph boundaries |
| Callback data length | 64 bytes | Use hash-based lookup map for selector paths |
| `sendChatAction` | Expires after 5s | Re-send every 4 seconds while agent is active |
| `createForumTopic` | ~20/min | Paced with 1.5s delay between each creation |

### 7.2 Rate Limit Implementation

Three layers of protection:

1. **grammy auto-retry plugin** (`@grammyjs/auto-retry`): Automatically catches 429 responses and waits the `retry_after` duration before retrying (up to 3 attempts, max 60s delay).

2. **SendQueue**: All outbound `sendMessage` and `editMessageText` calls are serialized through a queue with **~300ms** pacing between sends and **100ms** between edits (`TelegramTransport` constructor; see `send-queue.ts`). Edits have priority over sends. Typing actions bypass the queue. HTML parse errors trigger automatic plain-text fallback.

3. **Topic creation pacing**: `createForumTopic` calls during `/sync` and auto-creation are spaced 500ms apart.

### 7.3 Initial Sync Throttling

When a topic thread is first seen by the bot (e.g. after restart or first `/sync`), only the last 5 messages are sent. Older messages are marked as "seen" in the tracker so they won't be re-sent. Use `/history [N]` to retrieve more (default 30, scrolls chat to load older messages).

### 7.4 Message Batching

Consecutive tool calls that arrive in the same poll cycle are batched into a single Telegram message to reduce noise. The batch message is edited if more tool calls arrive in subsequent cycles.

---

## 8. Edge Cases

### 8.1 Window/Tab Not Found

If the user sends a message in a topic whose window or tab no longer exists (window closed, tab deleted):
- Bot replies with an error: "Window not found" with a list of open windows.
- The stale mapping entry is marked but not deleted (window may reopen).

### 8.2 Multiple Active Users

Multiple allowed users can interact simultaneously. Commands are processed sequentially (grammy's built-in queue). Approval button clicks are idempotent — clicking after someone else already approved has no effect (Cursor's button disappears).

### 8.3 Bot Restart

On restart, the bot has no message tracking state. It starts fresh:
- Existing topics are re-discovered by listing forum topics and matching names
- New messages are sent (no editing of old ones)
- The mapping file (if enabled) restores topic ↔ window+tab associations

### 8.4 Long Messages Split

When an assistant message exceeds 4096 chars:
1. Split at the last `\n\n` before the limit, or at the last `\n`, or at 4096 hard limit
2. Send each part as a separate message
3. Track all message IDs for the element so edits update the correct parts

### 8.5 Callback Data Overflow

Telegram limits callback data to 64 bytes. Selector paths can be hundreds of characters. Solution:
- Generate a short hash (8 chars) of the selector path
- Store the full path in a `Map<string, string>` (hash → selectorPath)
- Callback data format: `{action}:{elementId_short}:{hash}` (fits in 64 bytes)
- Map is cleared when the associated approval/action is no longer present

---

## 9. Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_ENABLED` | `false` | Enable/disable the Telegram transport |
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather (required if enabled) |
| `TELEGRAM_ALLOWED_USERS` | — | Optional: hardcode allowed user IDs (overrides /register token auth) |

---

## 10. Success Criteria

The Telegram transport is considered successful when:

1. The bot starts, prints a registration token, and connects via long polling
2. `/register <token>` authenticates users; `TELEGRAM_ALLOWED_USERS` overrides token auth when set
3. `/sync` validates the group (supergroup, forum, admin permissions) and enables auto-sync
4. Topics are auto-created for new windows/tabs via parallel CDP monitoring (no UI switching)
5. All windows are monitored simultaneously; messages stream into correct topics
6. Each ChatElement type renders correctly (human, assistant, tool, thought, plan, run_command)
7. Assistant messages are edited in-place as they stream; HTML fallback to plain text on parse errors
8. Pending approvals show inline keyboard buttons that trigger the correct action
9. Run command cards show the command text and [Run]/[Skip]/[Allow] buttons
10. Plan widgets show the todo list and [Build]/[View Plan] buttons
11. Text sent in a topic is forwarded to the mapped Cursor agent (window/tab auto-switched)
12. `/history [N]` sends the last N messages (default 30) with rate-limited pacing
13. `/mode` and `/model` commands show current state and allow switching
14. Typing indicator shown while agent is active
15. `/unsync` cleanly disables sync and deletes tracked topics; `/purge` deletes all topics
16. All state persisted in `data/` directory; survives restarts
