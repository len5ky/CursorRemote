# CursorRemote — Product Requirements Document

## 1. Overview

CursorRemote is a relay system that lets you monitor and control Cursor IDE's AI agent remotely — from a phone browser or a Telegram group. It connects to a running Cursor instance via the Chrome DevTools Protocol (CDP), extracts the agent chat state as structured data, and streams it to connected clients over a transport-agnostic event system. From a phone or Telegram you can read the conversation, approve or reject tool calls, run or skip shell commands, interact with plan widgets, send new prompts, switch chat tabs, and change agent mode/model — without touching the host machine.

### 1.1 Problem Statement

When running long Cursor agent sessions, the developer is tethered to the host machine. Stepping away means missed approval prompts that block the agent, wasted time, and broken flow. There is no built-in way to interact with Cursor's agent remotely.

### 1.2 Goal

Ship a working system that:

- Connects to a locally running Cursor IDE via CDP
- Extracts the agent chat panel state as structured, typed data — including plan widgets with todo lists and terminal command approval widgets
- Streams state to connected clients (web browser and Telegram) in real time via a transport-agnostic event system
- Lets the remote user approve/reject tool calls, run/skip shell commands, and trigger plan builds
- Supports chat tab switching, mode selection, and model selection
- Provides a Telegram bot integration using forum topics (one per project + chat tab) for monitoring and control
- Runs entirely on the local network (no cloud dependency, except Telegram API)

### 1.3 Non-Goals

- Authentication or multi-user access control for the web client
- Persistent chat history or database
- PWA / offline support
- Discord or other chat platform integrations (architecture supports it, but not implemented)

---

## 2. User Stories

### US-1: Remote Approval
**As a** developer away from my desk,
**I want to** see when the agent needs approval and tap Approve/Reject on my phone,
**so that** the agent is not blocked while I'm away.

### US-2: Remote Prompting
**As a** developer on my phone,
**I want to** type and send a new prompt to the agent,
**so that** I can redirect or continue the agent's work remotely.

### US-3: Conversation Monitoring
**As a** developer,
**I want to** read the full agent conversation on my phone with proper formatting (markdown, code blocks, tool calls, plans),
**so that** I can understand what the agent has done and is currently doing.

### US-4: Agent Status Awareness
**As a** developer,
**I want to** see at a glance whether the agent is idle, thinking, running a tool, or waiting for approval,
**so that** I know when my input is needed.

### US-5: Background Notification
**As a** developer with the web client in a background tab,
**I want to** receive a browser notification when any action needs my attention — global approvals, run command Skip/Run prompts, tool-level approvals (e.g. Fetch allowlisting, edit Accept/Skip), and other actionable tool widgets,
**so that** I don't miss time-sensitive prompts regardless of which tool type the agent invokes.

### US-6: Connection Resilience
**As a** developer,
**I want** the system to auto-reconnect when the network drops,
**so that** I don't have to manually refresh or restart anything.

### US-7: Chat Tab Management
**As a** developer,
**I want to** see all open chat tabs and switch between them from my phone,
**so that** I can manage multiple agent conversations remotely.

### US-8: Mode & Model Control
**As a** developer,
**I want to** change the agent mode (Agent/Ask/Manual) and model from my phone,
**so that** I can adjust the agent's behavior without returning to the host machine.

### US-9: Multi-Window Management
**As a** developer with multiple Cursor windows open,
**I want to** see all Cursor windows and switch between them from my phone,
**so that** I can monitor and control agents across different projects.

### US-10: Plan Widget Interaction
**As a** developer,
**I want to** see the full plan card — title, description, todo list with per-item status — and tap "Build" or "View Plan" from my phone or Telegram,
**so that** I can review and execute agent plans remotely.

### US-11: Shell Command Approval
**As a** developer,
**I want to** see the full shell command the agent wants to run (with description and command text) and tap "Run", "Skip", or "Allow" from my phone or Telegram,
**so that** I can make informed decisions about command execution without seeing only a generic approval prompt.

### US-12: Telegram Monitoring
**As a** developer using Telegram,
**I want to** see the agent conversation streamed into a Telegram forum topic (one per project + chat tab) with proper formatting and live updates,
**so that** I can monitor agent progress from Telegram without opening a browser.

### US-13: Telegram Control
**As a** developer using Telegram,
**I want to** send messages, approve/reject tool calls via inline buttons, switch modes/models, and trigger plan builds — all from Telegram,
**so that** I can fully control the agent from any device with Telegram installed.

### US-14: Agent Questionnaire
**As a** developer away from my desk,
**I want to** see and answer the agent's multiple-choice questions from my phone or Telegram,
**so that** the agent is not blocked waiting for my input while I'm away.

### US-15: Telegram Auto-Sync
**As a** developer using Telegram,
**I want to** run `/sync` once to enable auto-sync, after which new chat tabs automatically get forum topics created,
**so that** I don't need to manually create topics when starting new agent conversations.

---

## 3. System Architecture

```
┌─────────────────────────┐       CDP WebSocket        ┌───────────────────────────────────┐
│  Cursor IDE (Windows)   │ ←────── port 9222 ───────→ │  Relay Server (WSL2/Node.js)      │
│                         │                             │                                   │
│  Electron app with      │                             │  ┌─ CDP Bridge ─────────────────┐ │
│  --remote-debugging-port│                             │  │  Custom CdpClient (ws)        │ │
│                         │                             │  └──────────┬────────────────────┘ │
│  ┌─ Agent Chat Panel ─┐ │                             │             │                      │
│  │  Messages           │ │                             │  ┌──────────▼────────────────────┐ │
│  │  Tool calls         │ │                             │  │  DOM Extractor                │ │
│  │  Plan widgets       │ │                             │  │  Runtime.evaluate poll        │ │
│  │  Run command cards  │ │                             │  │  data-attribute driven        │ │
│  │  Approval buttons   │ │                             │  └──────────┬────────────────────┘ │
│  │  Composer input     │ │                             │             │                      │
│  │  Mode/Model select  │ │                             │  ┌──────────▼────────────────────┐ │
│  │  Chat tab sidebar   │ │                             │  │  State Manager                │ │
│  └─────────────────────┘ │                             │  │  (diff + event emission)      │ │
│                         │                             │  └──────┬──────────────┬──────────┘ │
│                         │                             │         │              │            │
│                         │                             │  ┌──────▼───────┐ ┌────▼──────────┐ │
│                         │                             │  │ Web Transport│ │ Telegram      │ │
│                         │                             │  │ (socket.io)  │ │ Transport     │ │
│                         │                             │  │ Express+WS   │ │ (grammy bot)  │ │
│                         │                             │  └──────┬───────┘ └────┬──────────┘ │
│                         │                             │         │              │            │
└─────────────────────────┘                             └─────────┼──────────────┼────────────┘
                                                                  │              │
                                                           socket.io        Telegram Bot API
                                                           port 3000             │
                                                                  │              │
                                                    ┌─────────────▼───┐  ┌───────▼──────────┐
                                                    │  Phone Browser   │  │  Telegram Group   │
                                                    │  Web client      │  │  Forum topics     │
                                                    │  - Chat elements │  │  - Chat log       │
                                                    │  - Plan widgets  │  │  - Inline buttons │
                                                    │  - Run commands  │  │  - /commands       │
                                                    │  - Approvals     │  │  - Typing status  │
                                                    │  - Mode/model    │  │  - Mode/model     │
                                                    └──────────────────┘  └──────────────────┘
```

### 3.0 Transport Architecture

The State Manager emits `state:patch` and `connection:changed` events. Any number of transports can subscribe independently. Each transport:

1. **Subscribes** to State Manager events for outbound data
2. **Calls** Command Executor methods (or CDP Bridge for window switching) for inbound commands
3. **Manages** its own connection lifecycle and client-specific state

Currently two transports are implemented:

- **Web Transport** (`relay.ts`): Express static server + socket.io. Forwards state events to browser clients, routes socket.io commands to the executor.
- **Telegram Transport** (`transports/telegram/`): grammy bot with long polling. Maps state to Telegram messages in forum topics, routes inline keyboard callbacks and text messages to the executor. See `docs/telegram_prd.md` for full specification.

### 3.1 Data Flow — Observation

1. The relay server polls Cursor's DOM every 500ms via `Runtime.evaluate` (CDP)
2. The extraction function runs inside Cursor's renderer, walking `[data-flat-index]` elements
3. It returns a structured `CursorState` object (typed `ChatElement[]`, approvals, tabs, mode, model)
4. The State Manager diffs against the previous state
5. Only changed fields are broadcast to connected clients via socket.io `state:patch`
6. Newly connected clients receive the full state via `state:full`

### 3.2 Data Flow — Commands

1. The phone client emits a socket.io event (e.g., `command:approve`, `command:send_message`)
2. The relay validates the payload and forwards to the Command Executor
3. The executor translates to CDP actions (Input.insertText, Input.dispatchKeyEvent, Runtime.evaluate)
4. CDP executes against Cursor's DOM
5. The next observation cycle picks up the resulting state change
6. The relay broadcasts the updated state to all clients

---

## 4. State Model

### 4.1 CursorState (top-level)

| Field              | Type               | Description                                  |
| ------------------ | ------------------ | -------------------------------------------- |
| `connected`        | `boolean`          | Whether CDP is connected to Cursor           |
| `agentStatus`      | `AgentStatus`      | Durable header status (`idle`, `waiting_approval`, `error`, etc.) |
| `agentActivityText` | `string \| null` | Live activity label; `null` means explicitly cleared on the wire |
| `agentActivityLive` | `boolean` | True only when current DOM signals prove active work |
| `agentActivitySource` | `'none' \| 'shimmer' \| 'loading_tool' \| 'loading_indicator' \| 'tail_thought'` | Provenance of the live activity signal |
| `messages`         | `ChatElement[]`    | Ordered chat elements (typed union)          |
| `pendingApprovals` | `Approval[]`       | Tool calls currently awaiting user decision  |
| `inputAvailable`   | `boolean`          | Whether the chat input is visible/focusable  |
| `chatTabs`         | `ChatTab[]`        | Open chat/composer tabs                      |
| `mode`             | `ModeInfo`         | Current and available agent modes            |
| `model`            | `ModelInfo`        | Current model name and ID                    |
| `windows`          | `CursorWindow[]`   | All discovered Cursor windows                |
| `activeWindowId`   | `string`           | ID of the currently connected window         |
| `composerQueue`    | `ComposerQueueState` | Prompts queued in composer toolbar         |
| `questionnaire`    | `Questionnaire \| null` | Agent questionnaire widget (multiple-choice questions) |

### 4.2 AgentStatus

One of: `idle`, `thinking`, `generating`, `running_tool`, `waiting_approval`, `error`

### 4.3 ChatElement (discriminated union)

Each element in the chat is one of eight types, identified by the `type` field:

#### HumanMessage (`type: 'human'`)

| Field       | Type                                    | Description                        |
| ----------- | --------------------------------------- | ---------------------------------- |
| `id`        | `string`                                | Message UUID from Cursor's DOM     |
| `flatIndex` | `number`                                | Sequential position in the chat    |
| `text`      | `string`                                | Plain text content                 |
| `mentions`  | `{ name: string; mentionType: string }[]` | @ mentions (files, terminals, etc.) |

#### AssistantMessage (`type: 'assistant'`)

| Field        | Type                                                      | Description                        |
| ------------ | --------------------------------------------------------- | ---------------------------------- |
| `id`         | `string`                                                  | Message UUID                       |
| `flatIndex`  | `number`                                                  | Sequential position                |
| `text`       | `string`                                                  | Plain text content                 |
| `html`       | `string`                                                  | Sanitized `.markdown-root` HTML    |
| `codeBlocks` | `CodeBlockItem[]` (see §6.11) | Structured code/diff blocks for native web/Telegram rendering |

#### ToolCallElement (`type: 'tool'`)

| Field         | Type     | Description                                            |
| ------------- | -------- | ------------------------------------------------------ |
| `id`          | `string` | Message UUID                                           |
| `flatIndex`   | `number` | Sequential position                                   |
| `toolCallId`  | `string` | Cursor's tool call ID                                  |
| `status`      | `string` | `'loading'` or `'completed'`                           |
| `action`      | `string` | Tool action name (Read, Edit, Shell) or status summary |
| `details`     | `string` | Target (filename, terminal, etc.)                      |
| `filename`    | `string?` | File being edited (from edit tool cards)               |
| `additions`   | `number?` | Lines added (from edit tool stats)                     |
| `deletions`   | `number?` | Lines deleted (from edit tool stats)                   |
| `summaryText` | `string?` | Full compact summary text (fallback)                   |
| `diffBlock`   | `CodeBlockItem?` | Structured diff/code for edit/review tools (web + Telegram) |

#### ThoughtBlock (`type: 'thought'`)

| Field       | Type     | Description                   |
| ----------- | -------- | ----------------------------- |
| `id`        | `string` | Generated ID                  |
| `flatIndex` | `number` | Sequential position           |
| `duration`  | `string` | e.g. "4s"                     |

#### PlanBlock (`type: 'plan'`)

Represents both the legacy plan execution summary (`.plan-execution-message-content`) and the rich plan widget (`.composer-create-plan-container`). The widget variant has additional fields.

| Field            | Type           | Description                                              |
| ---------------- | -------------- | -------------------------------------------------------- |
| `id`             | `string`       | Message UUID                                             |
| `flatIndex`      | `number`       | Sequential position                                      |
| `label`          | `string`       | Plan filename or label badge (e.g. "Build")              |
| `title`          | `string`       | Plan title (e.g. "Telegram Integration Module")          |
| `todosCompleted` | `number`       | Number of completed todos                                |
| `todosTotal`     | `number`       | Total number of todos                                    |
| `description`    | `string?`      | Plan overview/description text (widget only)             |
| `todos`          | `PlanTodo[]?`  | Individual todo items with status (widget only)          |
| `model`          | `string?`      | Model name shown in the plan widget (widget only)        |
| `actions`        | `PlanAction[]?`| View Plan and Build button selectors (widget only)       |

#### PlanTodo (sub-type of PlanBlock)

| Field    | Type     | Description                                        |
| -------- | -------- | -------------------------------------------------- |
| `text`   | `string` | Todo item content                                  |
| `status` | `string` | `'pending'`, `'completed'`, or `'in_progress'`     |

#### PlanAction (sub-type of PlanBlock)

| Field          | Type     | Description                             |
| -------------- | -------- | --------------------------------------- |
| `label`        | `string` | Button text ("View Plan", "Build")      |
| `type`         | `string` | `'view_plan'` or `'build'`              |
| `selectorPath` | `string` | CSS selector path to click via CDP      |

#### RunCommand (`type: 'run_command'`)

A terminal command that the agent wants to execute, shown as an interactive card with the full command text and Run/Skip/Allow buttons. This is distinct from a completed tool call — it represents a pending decision.

| Field         | Type           | Description                                              |
| ------------- | -------------- | -------------------------------------------------------- |
| `id`          | `string`       | Message UUID                                             |
| `flatIndex`   | `number`       | Sequential position                                      |
| `toolCallId`  | `string`       | Cursor's tool call ID                                    |
| `description` | `string`       | Header text (e.g. "Run outside sandbox:")                |
| `candidates`  | `string`       | Command name summary (e.g. "cd, source, npx, python3")  |
| `command`     | `string`       | Full command text                                        |
| `actions`     | `RunAction[]`  | Available buttons with selectors                         |

#### RunAction (sub-type of RunCommand)

| Field          | Type     | Description                                    |
| -------------- | -------- | ---------------------------------------------- |
| `label`        | `string` | Button text ("Run", "Skip", "Allow")           |
| `type`         | `string` | `'run'`, `'skip'`, or `'allow'`                |
| `selectorPath` | `string` | CSS selector path to click this button via CDP |

#### LoadingIndicator (`type: 'loading'`)

| Field       | Type     | Description                   |
| ----------- | -------- | ----------------------------- |
| `id`        | `string` | Generated ID                  |
| `flatIndex` | `number` | Sequential position           |

### 4.4 ChatTab

| Field         | Type      | Description                           |
| ------------- | --------- | ------------------------------------- |
| `composerId`  | `string`  | Cursor's internal composer ID         |
| `title`       | `string`  | Tab display name                      |
| `isActive`    | `boolean` | Whether this is the currently focused tab |
| `status`      | `string`  | Tab status (completed, running, etc.) |
| `selectorPath`| `string`  | CSS path to click to switch to tab    |

### 4.5 ModeInfo

| Field       | Type                                          | Description                |
| ----------- | --------------------------------------------- | -------------------------- |
| `current`   | `string`                                      | Current mode name          |
| `available` | `{ id: string; label: string; icon: string }[]` | Selectable modes          |

### 4.6 ModelInfo

| Field       | Type     | Description              |
| ----------- | -------- | ------------------------ |
| `current`   | `string` | Current model display name |
| `currentId` | `string` | Internal model identifier  |

### 4.7 CursorWindow

| Field   | Type     | Description                                |
| ------- | -------- | ------------------------------------------ |
| `id`    | `string` | CDP target ID                              |
| `title` | `string` | Project name parsed from window title      |
| `url`   | `string` | Target URL                                 |

### 4.8 Approval

| Field         | Type               | Description                              |
| ------------- | ------------------ | ---------------------------------------- |
| `id`          | `string`           | Unique identifier                        |
| `description` | `string`           | What is being approved                   |
| `actions`     | `ApprovalAction[]` | Available buttons                        |

### 4.9 ApprovalAction

| Field          | Type     | Description                                         |
| -------------- | -------- | --------------------------------------------------- |
| `label`        | `string` | Button text ("Accept", "Reject", etc.)              |
| `type`         | `string` | `'approve'`, `'reject'`, or `'approve_all'`         |
| `selectorPath` | `string` | CSS selector path used to click this button via CDP |

### 4.10 Questionnaire

Represents the agent's multiple-choice questionnaire toolbar (`.composer-questionnaire-toolbar`). Null when no questionnaire is active.

| Field                 | Type                      | Description                              |
| --------------------- | ------------------------- | ---------------------------------------- |
| `questions`           | `QuestionnaireQuestion[]` | All questions in the questionnaire       |
| `activeIndex`         | `number`                  | 0-based index of the active question     |
| `totalLabel`          | `string`                  | Stepper label, e.g. "1 of 3"            |
| `skipSelectorPath`    | `string`                  | CSS selector for the Skip button         |
| `continueSelectorPath`| `string`                  | CSS selector for the Continue button     |
| `continueDisabled`    | `boolean`                 | Whether Continue is disabled             |

### 4.11 QuestionnaireQuestion

| Field       | Type                      | Description                                    |
| ----------- | ------------------------- | ---------------------------------------------- |
| `number`    | `string`                  | Display number ("1.", "2.", etc.)               |
| `text`      | `string`                  | Question text                                  |
| `options`   | `QuestionnaireOption[]`   | Available answer options                       |
| `isActive`  | `boolean`                 | Whether this is the currently active question   |

### 4.12 QuestionnaireOption

| Field          | Type      | Description                                       |
| -------------- | --------- | ------------------------------------------------- |
| `letter`       | `string`  | Option letter ("A", "B", "C", "D")                |
| `label`        | `string`  | Option text ("Spring", "Summer", etc.)             |
| `isFreeform`   | `boolean` | True for the freeform "Other..." option            |
| `selectorPath` | `string`  | CSS selector path to click this option via CDP     |

---

## 5. Protocol — socket.io Events

### 5.1 Server → Client

| Event               | Payload                  | When                                  |
| ------------------- | ------------------------ | ------------------------------------- |
| `state:full`        | `CursorState`            | On initial client connection          |
| `state:patch`       | `Partial<CursorState>`   | When any state field changes          |
| `connection:status` | `{ connected: boolean }` | When CDP connects or disconnects      |
| `command:result`    | `{ id, ok, error? }`    | After a command executes or fails     |

### 5.2 Client → Server

| Event                  | Payload                                       | Description                    |
| ---------------------- | --------------------------------------------- | ------------------------------ |
| `command:send_message` | `{ commandId, text }`                         | Type and submit a new prompt   |
| `command:approve`      | `{ commandId, approvalId, selectorPath }`     | Click an approval button       |
| `command:approve_all`  | `{ commandId }`                               | Click "Accept All"             |
| `command:reject`       | `{ commandId, approvalId, selectorPath }`     | Click the reject button        |
| `command:switch_tab`   | `{ commandId, tabTitle }`                     | Switch to a different chat tab |
| `command:new_chat`     | `{ commandId }`                               | Create a new chat tab          |
| `command:set_mode`     | `{ commandId, modeId }`                       | Change agent mode              |
| `command:set_model`    | `{ commandId, modelId }`                      | Change model                   |
| `command:switch_window`| `{ commandId, windowId }`                     | Switch to a different Cursor window |
| `command:click_action` | `{ commandId, selectorPath }`                 | Click any action button by selector (Run, Skip, Allow, Build, View Plan) |

Every client command includes a `commandId` (UUID) that is echoed back in `command:result` for correlation.

---

## 6. UI/UX Specification

### 6.1 Layout

Mobile-first, single-column layout matching Cursor's dark theme. Four fixed zones:

1. **Header** (sticky top): Connection indicator + agent status
2. **Window bar** (below header): Project-level window selector (hidden when only 1 window)
3. **Tab bar** (below window bar): Chat tab selector within the active window (hidden when ≤ 1 tab)
4. **Messages** (scrollable middle): Typed chat elements with per-type rendering
5. **Footer** (sticky bottom): Approval bar (conditional) + mode/model pills + message input

### 6.2 Chat Elements

Each `ChatElement` type renders distinctly:

- **Human messages**: Right-aligned bubble with plain text and mention badges
- **Assistant messages**: Left-aligned bubble with sanitized HTML from Cursor's markdown renderer (prose only: bold, lists, inline code, links). Composer/Shiki widget roots are stripped from `html` so the page does not depend on VS Code theme CSS. **Code and diffs** render from structured `codeBlocks` (`CodeBlockItem`: `blockKind` `code` or `diff`, optional `filename`/`language`, `code` text, and for diffs `diffLines` with `add`/`rem`/`ctx`/`meta`/`hunk`). Blocks are appended after the prose bubble. Each block shows a toolbar (filename or language when known + **full-screen** control). The body sits in **`.code-block-viewport`**: at most ~**7 lines** tall with **scroll** for overflow; full-screen opens a modal (safe areas on mobile, backdrop or Escape closes, large close control).
- **Tool calls**: Compact single-line with status icon, action name, target details, and optionally filename with +/- change stats (green/red). **Edit / file-review tools** may include **`diffBlock`**: the same `CodeBlockItem` shape as assistant code blocks, rendered under the summary in **`.tool-diff-host`** with the same viewport, scroll, and full-screen behavior.
- **Thought blocks**: Single line in muted text: "Thought for Xs"
- **Plan widgets**: Rich card with title, description, scrollable todo list with colored status dots, progress bar, and action buttons (Build, View Plan), plus a full-plan modal and plan-scoped model picker in the web UI. See §6.9.
- **Run commands**: Command card with description header, monospace command text, and action buttons (Run, Skip, Allow). See §6.10.
- **Loading indicator**: Three animated dots

### 6.3 Approval Bar

- Appears between messages and input when `pendingApprovals.length > 0`
- Two large buttons: Approve (green) and Reject (red)
- Minimum 48px button height for reliable mobile tapping
- Disappears when no approvals remain

### 6.4 Message Input

- Full-width text area with a round send button
- Enter sends (Shift+Enter for newline on desktop)
- Text is submitted via CDP's `Input.insertText` + `Input.dispatchKeyEvent` for Enter

### 6.5 Window Picker

- Shows all discovered Cursor windows (CDP page targets with `workbench` in URL)
- Window titles are project names extracted from the window title (strips filename prefix and ` - Cursor` suffix)
- Active window highlighted, tap to switch (disconnects from current, connects to new target)
- Hidden when only one Cursor window is open
- Window list refreshes every 10 seconds

### 6.6 Chat Tab Bar

- Shows all open chat tabs extracted from `.agent-sidebar-cell` elements
- Active tab highlighted, tap to switch via title-based matching
- Hidden when 1 or fewer tabs

### 6.7 Status Indicators

- **Connection dot**: Green (connected), yellow (reconnecting), red (disconnected)
- **Agent status**: Text label with activity description (Idle, Thinking, Running tool, Needs approval, Error)

### 6.8 Visual Design

- Dark theme matching Cursor's actual colors (`#181818` bg, `rgba(228,228,228,0.92)` text)
- CSS custom properties for all colors
- Monospace font for code/tool descriptions, sans-serif for chat text
- No external CSS frameworks

### 6.9 Plan Widget

A rich interactive card that mirrors Cursor's plan UI. Rendered when a `PlanBlock` has the `todos` array populated (widget variant).

**Layout**:
- **Header**: Plan filename (muted, small) + title (bold)
- **Description**: Overview text below the title (if present)
- **Todo list**: Scrollable list (max-height ~200px) of todo items, each with:
  - Status dot: green (completed), blue (in_progress), gray (pending)
  - Todo text
  - Collapsed "N more" indicator if the widget had hidden items
- **Progress bar**: Track with filled portion + "N/M" text label
- **Actions row**: "View Plan" text button (left) + model name / picker (center) + "Build" primary button (right)

**Behavior**:
- "Build" emits `command:click_action` with the Build button's `selectorPath`
- "View Plan" opens a web modal; when a saved plan file is available, the modal loads the full plan body and todo list from disk so the phone view matches Telegram's full-plan view
- Tapping the model pill opens a web-side picker populated from Cursor's current plan model menu, then applies the selected option back in Cursor
- "Build" emits `command:click_action` with the Build button's `selectorPath`
- The card updates in-place as todo statuses change during plan execution

### 6.10 Run Command Widget

An interactive command approval card shown when the agent wants to execute a shell command.

**Layout**:
- **Header**: Description text (e.g. "Run outside sandbox:") + command candidates in muted text
- **Command block**: Full command text in monospace font, dark background, horizontally scrollable for long commands. Prefixed with `$` prompt symbol.
- **Action row**: "Skip" text button (left) + "Run" primary button (right). "Allow" button appears when sandbox permission is needed.

**Behavior**:
- "Run" emits `command:click_action` with the Run button's `selectorPath`
- "Skip" emits `command:click_action` with the Skip button's `selectorPath`
- "Allow" emits `command:click_action` with the Allow button's `selectorPath`

### 6.11 Native code blocks & diffs (`codeBlocks`, `diffBlock`, web UX)

**Data model** (`src/server/types.ts` — `CodeBlockItem`):

- `blockKind`: `'code'` | `'diff'`
- `filename`, `language` (optional)
- `code`: flat text with real newline preservation for plain blocks (line-aware fallback, not raw `textContent`)
- `diffLines` (when `blockKind === 'diff'`): `{ kind: 'add'|'rem'|'ctx'|'meta'|'hunk'; text: string }[]` — kinds come from live Monaco line decorations in the extractor, not from parsing mirrored HTML.

**Assistant**: `html` is **`.markdown-root` innerHTML only** (prose). The DOM extractor builds **`codeBlocks`** from `composer-code-block-container` / `composer-message-codeblock` / related paths without merging composer widget HTML into `html`.

**Tools (edit / review)**: When a matching composer block exists, **`diffBlock`** carries the same structured shape; the web client renders it in **`.tool-diff-host`**.

**Patch text without Monaco diff**: If Cursor emits plain patch / unified-diff text (for example `@@` hunks and `+` / `-` lines inside a normal code block), the extractor upgrades it to `blockKind: 'diff'` so the native renderer still shows red/green line styling instead of a flat raw code block.

**Web client** (`src/client/app.js`, `src/client/styles.css`):

- **`createNativeBlockFromItem`**: toolbar + **`.code-block-viewport`** (max height ≈ 7 lines via CSS variables `--cb-font`, `--cb-lh`, `--cb-lines`) + inner `.code-block-diff-plain` (diff rows or `<pre><code>`).
- **Full screen**: expand control opens **`.code-block-fs-overlay`** (modal, `aria-modal`, safe-area padding, momentum scroll in panel body). Close: control, backdrop, or Escape. Body scroll locked while open.
- **Mobile**: minimum **44×48px** touch targets on expand and close; `-webkit-overflow-scrolling: touch`; `overscroll-behavior: contain` on scroll regions.

**Telegram**: `formatter.ts` maps composer nodes to `<pre><code>` using structured `codeBlocks` / diff line prefixes where applicable (no Monaco mirror).

**Limitation**: If Cursor has not yet painted editor lines (collapsed widget), `codeBlocks` / `diffBlock` may be empty until a later poll.

---

## 7. DOM Extraction Strategy

### 7.1 Challenge

Cursor is an Electron app based on VS Code. Its DOM uses generated class names that change between versions. There is no public API for accessing chat state.

### 7.2 Approach — Data-Attribute-Driven Extraction

Cursor's chat DOM uses reliable `data-*` attributes for structured identification:

- `data-flat-index="N"` — sequential index on each message wrapper
- `data-message-role="human|ai"` — message author
- `data-message-kind="human|assistant|tool"` — message type
- `data-message-id="UUID"` — stable message identifier
- `data-tool-call-id="ID"` — tool call identifier
- `data-tool-status="loading|completed"` — tool execution status
- `data-compact="true"` — collapsed tool summary

The extraction function selects all `[data-flat-index]` elements inside the chat container, then uses the `data-message-role` + `data-message-kind` attributes to classify each element and extract type-specific content:

| Type        | DOM Indicators                                        | Content Extracted                                     |
| ----------- | ----------------------------------------------------- | ----------------------------------------------------- |
| human       | `role=human`, `kind=human`                            | `.aislash-editor-input-readonly` text, `.mention` elements |
| assistant   | `role=ai`, `kind=assistant`                           | `.markdown-root` innerHTML + textContent; `codeBlocks` from composer code widgets |
| tool        | `role=ai`, `kind=tool`                                | `data-tool-call-id`, `data-tool-status`, `.ui-tool-call-line-action/details`, edit stats |
| plan        | `role=ai`, `kind=tool` + `.composer-create-plan-container` | Plan filename, title, description, todo items with status, Build/View Plan selectors, model |
| plan (legacy)| `.plan-execution-message-content`                    | Label, title, todo summary counts                     |
| run_command | `role=ai`, `kind=tool` + `.composer-terminal-tool-call-block-container` | Description, candidates, full command text, Run/Skip/Allow button selectors |
| thought     | `.ui-collapsible.ui-step-group-collapsible`           | Duration from header spans                            |
| loading     | `.loading-indicator-v3`                               | Presence only                                         |

For elements outside the data-attribute system (chat container, input, approve/reject buttons, status, tabs, mode/model), CSS selectors from `selectors.json` are used with a cascade strategy.

### 7.3 Discovery Tool

A CLI utility (`src/discovery/discover-dom.ts`, run via `npm run discover`) connects to Cursor via CDP and:

1. Lists all CDP targets (pages, webviews, workers)
2. Dumps a summarized DOM tree of the main window
3. Searches for elements matching chat/agent patterns
4. Outputs suggested selectors for `selectors.json`

### 7.4 Polling & Diffing

- The extractor runs every `POLL_INTERVAL_MS` (default 500ms)
- A debounce of `DEBOUNCE_MS` (default 300ms) prevents broadcast storms during streaming
- The State Manager deep-compares (JSON.stringify) each top-level field
- Only changed fields are included in the `state:patch` event

---

## 8. Configuration

All configuration is via environment variables with sensible defaults:

**Core**:

| Variable           | Default                    | Description                              |
| ------------------ | -------------------------- | ---------------------------------------- |
| `CDP_URL`          | `http://127.0.0.1:9222`   | Cursor's CDP endpoint                    |
| `SERVER_PORT`      | `3000`                     | Port for the web client + socket.io      |
| `SERVER_HOST`      | `0.0.0.0`                 | Bind address (0.0.0.0 for LAN access)   |
| `POLL_INTERVAL_MS` | `500`                      | DOM polling frequency in ms              |
| `DEBOUNCE_MS`      | `300`                      | Minimum broadcast interval in ms         |
| `SELECTORS_PATH`   | `./selectors.json`         | Path to DOM selector configuration       |
| `LOG_LEVEL`        | `info`                     | Logging verbosity (debug/info/warn/error)|

**Telegram Transport**:

| Variable                 | Default  | Description                                      |
| ------------------------ | -------- | ------------------------------------------------ |
| `TELEGRAM_ENABLED`       | `false`  | Enable or disable the Telegram transport         |
| `TELEGRAM_BOT_TOKEN`     | —        | Bot token from @BotFather (required if enabled)  |
| `TELEGRAM_ALLOWED_USERS` | —        | Optional: hardcode allowed user IDs (overrides token auth) |

---

## 9. Technical Requirements

### 9.1 Server

- Node.js 20+
- TypeScript in strict mode
- Custom lightweight CDP client (`ws` library) — NOT Puppeteer (blocked by Electron)
- `express` for HTTP static serving
- `socket.io` for WebSocket with automatic reconnection and transport fallback
- `grammy` for Telegram Bot API (TypeScript-first, supports Bot API 9.5, forum topics, inline keyboards)
- `node-html-parser` for converting Cursor's complex HTML to Telegram-safe HTML (DOM tree walking)
- `tsx` for development (TypeScript execution with hot-reload via `tsx watch`)

### 9.2 Client

- Vanilla HTML/CSS/JavaScript (no framework, no build step)
- socket.io client auto-served from the server
- Works on modern mobile browsers (Safari iOS 15+, Chrome Android 90+)
- No external CDN dependencies

### 9.3 Host Environment

- Cursor IDE running on Windows with `--remote-debugging-port=9222`
- Relay server running on WSL2 (same machine)
- Phone on the same local network as the Windows host

---

## 10. Key Technical Decisions

### 10.1 Custom CDP Client vs. Puppeteer

**Decision**: Custom lightweight CDP client using `ws` directly.

**Rationale**: Electron/Cursor blocks `Target.getBrowserContexts` which Puppeteer requires. Our client connects directly to the page target's WebSocket URL, bypassing browser-level API calls.

### 10.2 CDP Input Domain for Text Entry

**Decision**: Use `Input.insertText` and `Input.dispatchKeyEvent` for typing.

**Rationale**: Cursor uses ProseMirror/TipTap for its chat composer. DOM-level methods (`document.execCommand`, `element.value=`) bypass ProseMirror's internal state model. CDP's Input domain goes through Chromium's native input pipeline, which ProseMirror handles correctly.

### 10.3 Data-Attribute Extraction vs. Class-Based Selectors

**Decision**: Use `data-flat-index`, `data-message-role`, `data-message-kind` for message extraction.

**Rationale**: Class names are generated and change between Cursor versions. Data attributes are semantic and stable — they represent Cursor's internal data model.

---

## 11. Implementation Status

| Feature                     | Status      | Notes                                         |
| --------------------------- | ----------- | --------------------------------------------- |
| CDP connection + discovery  | Done        | Custom CDP client, target auto-discovery      |
| Multi-window support        | Done        | Discover all workbench targets, window picker UI, switchWindow command |
| DOM extraction (messages)   | Done        | Typed ChatElement extraction via data attrs   |
| DOM extraction (tabs/mode)  | Done        | `.agent-sidebar-cell` tabs + mode/model from dropdown |
| State management + diffing  | Done        | JSON diff, debounced broadcasts, windows tracked separately from DOM |
| Message sending             | Done        | Input.insertText + Enter via CDP              |
| Approval buttons            | Done        | Text matching + selector-based click          |
| Chat tab switching          | Done        | Title-based match on `.agent-sidebar-cell` via JS `.click()` |
| Mode switching              | Done        | JS `.click()` on dropdown trigger + items     |
| Model switching             | Done        | JS `.click()` on dropdown trigger + items, menu close verification |
| Mobile model menu           | Done        | MAX toggle, categories, brain badges          |
| Mobile web client           | Done        | Per-type chat rendering, Cursor-matched theme |
| Auto-reconnection           | Done        | Both CDP and socket.io sides                  |
| Browser notifications       | Done        | On pending approvals, run command prompts, and tool-level actions (Fetch, Edit, etc.) |
| Plan widget extraction      | Done        | `.composer-create-plan-container` → structured PlanBlock with todos, actions |
| Plan widget web rendering   | Done        | Rich card with todo list, Build/View Plan buttons |
| Run command extraction      | Done        | `.composer-terminal-tool-call-block-container` → RunCommand with command text, actions |
| Run command web rendering   | Done        | Command card with monospace text, Run/Skip/Allow buttons |
| Native code / diff (web) | Done | `codeBlocks` / `diffBlock` → `.native-code-block`; ~7-line viewport + scroll + full-screen modal; no Monaco HTML mirror |
| Transport abstraction       | Done        | Transport interface, SendQueue, MessageTracker, WindowMonitor |
| Telegram transport          | Done        | grammy bot, auto-sync, /register auth, parallel CDP, inline keyboards |
| Setup documentation         | Partial     | Needs setup guide for new users               |

---

## 12. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
| ---- | ------ | ---------- | ---------- |
| Cursor DOM structure changes between versions | Extraction breaks | High | Data-attribute extraction + externalized selectors + discovery tool |
| Token-by-token streaming causes broadcast storms | High CPU/bandwidth | High | Debounce broadcasts, send diffs not full state |
| WSL2 networking blocks phone access | Client can't connect | Medium | Document mirrored mode and port forwarding setups |
| ProseMirror rejects programmatic input | Message sending fails | Low | CDP Input domain goes through native Chromium pipeline |
| Cursor updates change approval button layout | Approve/reject stops working | High | Text-content matching fallback, discovery tool for re-mapping |
| Multiple Cursor windows share one CDP port | Commands sent to wrong window | Low | Window picker UI, explicit window switching, periodic window list refresh |
| Element IDs contain dots or colons | CSS selector paths break | Medium | Escape special chars in `buildSelectorPath` |
| Telegram message edit rate limits | Updates dropped or delayed | Low | 500ms poll + 300ms debounce = ~1 edit/sec, well within Telegram's ~30/sec limit |
| Telegram 4096 char message limit | Long assistant messages truncated | Medium | Split into multiple messages, track all message IDs per element |
| Telegram callback_data 64 byte limit | Can't encode full selector paths | High | Hash-based lookup map for selector paths in callback data |
| Plan widget DOM changes between Cursor versions | Plan extraction breaks | Medium | Detect by `.composer-create-plan-container` class, fall back to legacy `.plan-execution-message-content` |
| Run command widget variants (sandbox, allow) | Missing buttons or misclassified | Medium | Detect by `.composer-terminal-tool-call-block-container`, extract all buttons by class pattern |
| Non-active window/tab state goes stale in Telegram | Topics show outdated info | High | Document limitation; auto-switch on user interaction; future background sweep mode |

---

## 13. Future Roadmap

- **Discord transport**: Reuse the Transport interface for a Discord bot (threads as topics)
- **Multi-window background sweep**: Periodically cycle through non-active windows to keep all Telegram topics updated
- **Authentication**: Token-based auth middleware on HTTP and socket.io
- **Web code UX**: Optional copy-to-clipboard, configurable inline preview height (default ~7 lines)
- **Auto-approval rules**: Configurable rules like "auto-approve read operations"
- **PWA**: Service worker + manifest for "Add to Home Screen"
- **Push notifications**: Web Push API for alerts when browser is closed
- **Dynamic model list**: Extract available models from Cursor's DOM instead of hardcoding

---

## 14. Success Criteria

The system is considered successful when:

**Web client**:
1. The relay server connects to a running Cursor IDE via CDP
2. The web client on a phone displays the agent conversation with proper formatting
3. Each chat element type renders distinctly (human, assistant, tool, thought, plan widget, run command)
4. Plan widgets show the full todo list with status indicators, and Build/View Plan buttons work
5. Run command widgets show the full command text, and Run/Skip/Allow buttons work
6. Tapping Approve/Reject on the phone triggers the action in Cursor
7. Typing and sending a message from the phone appears in Cursor's composer and submits
8. Chat tabs, mode, and model can be switched from the phone
9. The system recovers automatically from temporary connection drops
10. Latency from action to reflection is under 2 seconds

**Telegram transport**:
11. The Telegram bot connects, users register with `/register <token>`, and `/sync` enables auto-sync to a forum group
12. Topics are auto-created for new windows and chat tabs when sync is enabled. All windows monitored via parallel CDP connections (no UI switching)
13. The active window+tab's conversation streams into its Telegram topic with proper formatting (last 5 messages on initial sync)
14. `/history [N]` sends the last N messages (default 30) into the topic with rate-limited pacing
15. Each ChatElement type renders with appropriate Telegram formatting (HTML, code blocks, inline keyboards)
16. Approval inline buttons (Accept/Reject/Accept All) trigger the correct action in Cursor
17. Run command cards show the command and offer Run/Skip/Allow inline buttons
18. Plan widgets show the todo list and offer Build/View Plan inline buttons
19. Typing in a topic sends the text as a message to the mapped Cursor window+tab
20. `/mode` and `/model` commands show current state and allow switching via inline keyboards
21. The bot shows a typing indicator while the agent is active
22. All outbound API calls are rate-limited via SendQueue (~300ms sends, 100ms edits in Telegram transport) + auto-retry plugin
23. Token-based auth (`/register`) with optional `TELEGRAM_ALLOWED_USERS` override. Data persisted in `data/` directory.
