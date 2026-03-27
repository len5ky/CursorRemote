# Architecture — CursorRemote

## 1. High-Level Overview

The system has three tiers connected by two protocol bridges:

```
Cursor IDE  ←──CDP──→  Relay Server  ←──socket.io──→  Phone Client
(Windows)               (WSL2/Node)                   (Browser)
```

- **Cursor IDE** is a stock Electron app launched with `--remote-debugging-port=9222`. It exposes the Chrome DevTools Protocol over a WebSocket. We do not modify Cursor in any way.
- **Relay Server** is a Node.js/TypeScript process running in WSL2. It bridges CDP on one side and socket.io on the other.
- **Phone Client** is a static HTML/CSS/JS page served by the relay. It communicates exclusively via socket.io events.

---

## 2. Component Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Relay Server                         │
│                                                          │
│  ┌─────────────┐    ┌───────────────┐    ┌───────────┐  │
│  │  CDP Bridge  │───→│ DOM Extractor │───→│   State   │  │
│  │              │    │               │    │  Manager  │  │
│  │  CdpClient   │    │ callFunction  │    │           │  │
│  │  WebSocket   │    │ data-attr     │    │  diff     │  │
│  │  lifecycle   │    │ extraction    │    │  events   │  │
│  └──────┬───────┘    └───────────────┘    └─────┬─────┘  │
│         │                                       │        │
│         │            ┌───────────────┐          │        │
│         │            │   Command     │          │        │
│         └───────────→│   Executor    │          │        │
│                      │               │          │        │
│                      │  CDP Input    │          │        │
│                      │  evaluate     │          │        │
│                      │  approve/deny │          │        │
│                      └───────┬───────┘          │        │
│                              │                  │        │
│                      ┌───────▼──────────────────▼─────┐  │
│                      │         Relay                  │  │
│                      │  Express (static files)        │  │
│                      │  socket.io (state + commands)  │  │
│                      └────────────────────────────────┘  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 2.1 CDP Client (`cdp-client.ts`)

**Responsibility**: Lightweight Chrome DevTools Protocol client using raw WebSocket.

**Why not Puppeteer**: Electron/Cursor blocks `Target.getBrowserContexts` which `puppeteer-core` requires during connection. Our client connects directly to the page target's WebSocket URL.

**API**:
- `connect(wsUrl)` — connect to a page target's WebSocket
- `evaluate(expression)` — `Runtime.evaluate` with return-by-value
- `callFunction(fn, ...args)` — serialize a function + args, evaluate in page context. Injects a `__name` shim because tsx/esbuild wraps named functions with `__name()` calls
- `typeText(text)` — `Input.insertText` (native Chromium input pipeline)
- `pressKey(key, code, keyCode, modifiers)` — `Input.dispatchKeyEvent` (keyDown + keyUp)
- `click(selector)` — evaluate to scroll + click
- `exists(selector)` — check element presence

### 2.2 CDP Bridge (`cdp-bridge.ts`)

**Responsibility**: Discover Cursor windows, establish and maintain a CDP connection, and support window switching.

**Multi-window support**: All Cursor windows share a single CDP port (9222). Each window appears as a separate `page` target at `/json`. The bridge discovers all workbench page targets and exposes them as `CursorWindow[]`. Only one window is connected at a time; the user switches via the phone UI.

**Workspace name extraction**: After connecting to a target, the bridge runs `Runtime.evaluate` to read `vscode.context.configuration().workspace.uri` — a stable internal API available in every Cursor/VS Code Electron renderer. The `uri.path` basename gives the project folder name, and `uri.authority` provides the remote qualifier (WSL, SSH, etc.). This is platform-independent and unaffected by the volatile `document.title`. The qualifier suffix (e.g. `[WSL: ubuntu-24.04]`) can be disabled by setting `WINDOW_TITLE_QUALIFIER=false` in `.env` for cleaner Telegram topic names. For non-connected windows (discovered via `/json` but not yet polled), the bridge falls back to parsing the CDP target title: strip ` - Cursor` suffix, split on ` - `, take the project segment.

**Lifecycle**:
1. Fetch target list from `http://<CDP_URL>/json`
2. Filter all pages with `workbench` in URL → expose as `windows`
3. Connect `CdpClient` to the selected (or first) target's `webSocketDebuggerUrl`
4. Expose the `CdpClient` and `activeTargetId` to other modules
5. On disconnect: emit event, start reconnection loop with exponential backoff

**Window switching** (`switchWindow(targetId)`):
1. Disconnect current CdpClient
2. Emit `disconnected` (extractor stops, executor clears client)
3. Call `connect(targetId)` for the new window
4. Emit `connected` (extractor restarts, executor gets new client)

**Periodic refresh**: Every 10 seconds, `refreshWindows()` re-fetches `/json` to discover newly opened or closed Cursor windows without reconnecting.

### 2.3 DOM Extractor (`dom-extractor.ts`)

**Responsibility**: Periodically extract structured state from Cursor's DOM.

**How it works**:
1. The extraction function is passed as a serialized function via `client.callFunction()`
2. Inside Cursor's renderer, it selects all `[data-flat-index]` elements
3. For each element, reads `data-message-role` + `data-message-kind` to classify
4. Extracts type-specific content into typed `ChatElement` objects
5. **Assistant messages**: `html` is **`.markdown-root` innerHTML only** (prose). **`codeBlocks`** is an array of **`CodeBlockItem`** structs built from composer code widgets (Shiki lines, Monaco `.view-line` text, line-aware plain-code fallback, diff decorations → `diffLines` with `add`/`rem`/`ctx`/…).
6. **ToolCallElement**: when a composer code block is present on edit-review / compact / line tools, **`diffBlock`** stores the same **`CodeBlockItem`** shape for native web (and Telegram) rendering — not mirrored widget HTML.
7. Also extracts approval buttons, base status UI, chat tabs, mode, model info, composer queue, and raw activity signals (`_rawSignals`)
8. A shared helper (`activity-derive.ts`) converts `_rawSignals` + parsed messages into `agentStatus`, `agentActivityText`, `agentActivityLive`, and `agentActivitySource` so web + Telegram use the same live-activity contract
9. Returns a complete `CursorState` object or `null` on failure

**Element classification**:

| data-message-role | data-message-kind | Result Type      |
| ----------------- | ----------------- | ---------------- |
| human             | human             | HumanMessage or PlanBlock (legacy) |
| ai                | assistant         | AssistantMessage |
| ai                | tool              | PlanBlock (widget), RunCommand, or ToolCallElement |
| (none)            | (none)            | ThoughtBlock, LoadingIndicator, or skipped |

Within the `ai`/`tool` branch, classification priority:
1. `.composer-create-plan-container` → **PlanBlock** (widget variant with todos, actions)
2. `.composer-terminal-tool-call-block-container` → **RunCommand** (command text, Run/Skip/Allow)
3. `.composer-edit-file-review-wrapper` → **ToolCallElement** (edit/review card; optional **`diffBlock`** when a code block is present)
4. `.composer-tool-former-message` → **ToolCallElement** (compact summary; may include **`diffBlock`**)
5. `.ui-tool-call-line-action` → **ToolCallElement** (expanded tool call line; may include **`diffBlock`**)

**Key DOM selectors used inside extraction**:

| Target                  | Selector / Attribute                                    |
| ----------------------- | ------------------------------------------------------- |
| Message wrappers        | `[data-flat-index]`                                     |
| Human text              | `.aislash-editor-input-readonly`                        |
| Mentions                | `.mention[data-mention-name]`                           |
| AI markdown content     | `.markdown-root` innerHTML → assistant `html` (prose only) |
| Code blocks             | `.composer-message-codeblock`, `.composer-code-block-container`, `.ui-code-block` → `codeBlocks[]` / `diffBlock` |
| Tool structured diff    | Composer block inside tool host → `ToolCallElement.diffBlock` (`CodeBlockItem`) |
| Tool call line          | `.ui-tool-call-line-action`, `.ui-tool-call-line-details` |
| Compact tool summary    | `.composer-tool-former-message`                         |
| Edit tool stats         | `.ui-edit-tool-call__filename`, `__additions`, `__deletions` |
| Thought duration        | `.ui-collapsible-header span` (text "for Xs")           |
| Plan block (legacy)     | `.plan-execution-label`, `.plan-execution-title`         |
| Plan widget             | `.composer-create-plan-container`                        |
| Plan widget title       | `.composer-create-plan-title`                            |
| Plan widget label       | `.composer-create-plan-label`                            |
| Plan widget description | `.composer-create-plan-text .markdown-root`              |
| Plan widget todos       | `.composer-create-plan-todo-item`                        |
| Plan todo status        | `.composer-plan-todo-indicator-pending`, `-completed`, `-in_progress` |
| Plan todo text          | `.composer-create-plan-todo-content`                     |
| Plan Build button       | `.composer-create-plan-build-button`                     |
| Plan View Plan button   | `.composer-create-plan-view-plan-button`                 |
| Run command container   | `.composer-terminal-tool-call-block-container`            |
| Run command description | `.composer-terminal-top-header-description`               |
| Run command candidates  | `.composer-terminal-top-header-candidates`                |
| Run command text        | `.composer-terminal-command-expanded-text`                |
| Run skip button         | `.composer-skip-button`                                   |
| Run run button          | `.composer-run-button`                                    |
| Todo progress           | `.todo-summary-content` (regex `\d+ of \d+`)            |
| Loading indicator       | `.loading-indicator-v3`                                  |
| Chat tabs               | `.agent-sidebar-cell` (aria-label/title/textContent)     |
| Mode                    | `data-mode` on `.composer-unified-dropdown`              |
| Model name              | Text in `.composer-unified-dropdown-model` trigger       |

### 2.4 Command Executor (`command-executor.ts`)

**Responsibility**: Translate remote commands into CDP actions on Cursor's DOM.

**Commands**:

| Command | Implementation |
| ------- | -------------- |
| `send_message(text)` | 1. Find input via selector cascade + `evaluate()`. 2. Focus + click. 3. Ctrl+A + Backspace to clear. 4. `Input.insertText` for text. 5. `Input.dispatchKeyEvent` for Enter. |
| `approve(selectorPath)` | Evaluate to scroll into view + click. |
| `reject(selectorPath)` | Same as approve for the reject button. |
| `approve_all()` | Find "Accept All" button by text matching + click. |
| `switch_tab(tabTitle)` | Find `.agent-sidebar-cell` by title text, JS `.click()`. |
| `new_chat()` | Click the new chat button via selector cascade. |
| `set_mode(modeId)` | JS `.click()` on mode dropdown trigger, then `.click()` on target mode item. |
| `set_model(modelId)` | JS `.click()` on model dropdown trigger, then `.click()` on target model item `.composer-unified-context-menu-item`. Verifies menu closes after selection. |
| `click_action(selectorPath)` | Generic action button click. Evaluate to scroll into view + JS `.click()`. Used for Run, Skip, Allow, Build, View Plan buttons extracted with their `selectorPath`. |

**Why CDP Input domain for typing**: Cursor uses ProseMirror/TipTap for its chat composer. DOM-level methods (`document.execCommand`, `element.value=`) bypass ProseMirror's internal state model. CDP's `Input.insertText` and `Input.dispatchKeyEvent` go through Chromium's native input pipeline, which ProseMirror processes correctly via its `beforeinput`/`input` event handlers.

**Retry policy**: Up to 2 retries with 500ms delay. Returns `{ ok: boolean, error?: string }`.

### 2.5 State Manager (`state-manager.ts`)

**Responsibility**: Diff successive states and emit granular change events.

**Algorithm**:
1. Receive new `CursorState` from extractor
2. JSON.stringify-compare each top-level field with previous state
3. Build a patch object containing only changed fields
4. Debounce patches (300ms default) to prevent broadcast storms during streaming
5. Emit `state:patch` event

**Bridge-managed fields**: `windows` and `activeWindowId` are not populated by DOM extraction (which only sees one window). They are set by `updateWindows()` called from `index.ts` after CDP bridge connects or refreshes. The diff preserves these fields when applying extractions.

**Events emitted**:
- `state:patch` — partial state change
- `connection:changed` — CDP connection status flip

### 2.6 Transport Layer

The system uses a transport-agnostic architecture. The State Manager emits events; any number of transports can subscribe independently. Each transport handles its own connection lifecycle, client format, and command routing.

#### Web Transport (`relay.ts`)

**Responsibility**: Serve the web client and bridge socket.io with the backend.

**HTTP**:
- `GET /` → serves `src/client/` as static files
- `GET /health` → returns `{ ok, connected, agentStatus, clients, uptime, windows, activeWindowId, mode, model, chatTabCount, pendingApprovalCount, generation }`

**socket.io**:
- On new connection: send `state:full`
- Route `command:*` events to Command Executor
- Route `command:switch_window` to CDP Bridge directly
- Forward State Manager events to all connected sockets

**Web client** (`src/client/app.js`, `src/client/styles.css`):

- Renders `ChatElement` types into `#messages`; assistant HTML is passed through `sanitizeHtml` (strips scripts, event handlers, and embedded composer/Shiki roots).
- **Native code/diff**: `createNativeBlockFromItem()` builds `.code-block.native-code-block` with a toolbar (title + full-screen), **`.code-block-viewport`** capped at ~7 lines (`--cb-font`, `--cb-lh`, `--cb-lines`) with scroll, and green/red line styles for structured diffs. Assistant **`codeBlocks`** append after prose; tool **`diffBlock`** mounts under **`.tool-diff-host`** (`syncToolDiffHost` / `updateToolEl`). Plain patch text is also classified to `diffLines` server-side so non-Monaco diffs still render with add/remove colors.
- **Full-screen reader**: Expand opens **`.code-block-fs-overlay`** (modal, safe-area padding, backdrop + Escape close, 44px+ controls). Body scroll is locked while open.

#### Telegram Transport (`transports/telegram/`)

**Responsibility**: Bridge Cursor state to a Telegram supergroup with forum topics via the grammy bot framework.

**Components**:
- `index.ts` — Transport lifecycle: start/stop bot, subscribe to State Manager events, route state patches to the formatter and message tracker
- `formatter.ts` — Convert each `ChatElement` type to Telegram HTML. Uses `node-html-parser` DOM tree walking for accurate HTML conversion (handles Shiki code blocks, headings, class-based bold, tables). Handles 4096 char splitting, inline keyboard generation for actions
- `topic-manager.ts` — Map `windowTitle::tabTitle` to Telegram forum topic `threadId`. Create topics via Bot API `createForumTopic`
- `message-tracker.ts` — Track `ChatElement.id` → Telegram `message_id` per topic. Decides whether to send a new message or edit an existing one
- `commands.ts` — Bot command handlers (`/topics`, `/mode`, `/model`, `/status`, `/plan`, `/agent`)

**Inbound flow** (Telegram → Cursor):
1. User sends text in a forum topic → resolve topic to window+tab → switch if needed → `commandExecutor.sendMessage(text)`
2. User taps inline keyboard button → decode callback data → call appropriate executor method (`clickApproval`, `clickAction`, `setMode`, `setModel`)
3. User sends `/mode` command → bot replies with current mode + inline keyboard → user taps → `commandExecutor.setMode(modeId)`

**Outbound flow** (Cursor → Telegram):
1. State Manager emits `state:patch` with changed `messages` (and related fields)
2. `WindowMonitor` drives `doProcessWindow` per mapped topic: **activity line** (send/edit/delete from `agentActivityText` only when `agentActivityLive` is true, with dedup against in-flight step-summary thoughts), **composer queue** message, then chat elements
3. Transport diffs new vs. tracked messages per topic
4. New elements → `sendMessage` with formatted HTML + optional inline keyboard
5. Changed elements (e.g. streaming assistant text) → `editMessageText` on tracked message ID
6. While `agentActivityLive` is true and `agentStatus` is an active mode → `sendChatAction('typing')` every 4 seconds

**Access control**: Middleware checks `update.from.id` against `TELEGRAM_ALLOWED_USERS` allowlist. Bot must be group admin with privacy mode OFF.

**Configuration**: See `TELEGRAM_*` env vars in `docs/prd.md` §8.

Full specification: `docs/telegram_prd.md`. Detailed architecture: `docs/telegram_architecture.md`.

---

## 3. Networking Model

### 3.1 CDP Connection (Relay → Cursor)

```
WSL2 process → localhost:9222 → Windows Cursor
```

WSL2 forwards localhost to the Windows host by default.

### 3.2 Client Connection (Phone → Relay)

```
Phone → <windows-lan-ip>:3000 → (port forward) → WSL2 relay server
```

Requires one of:
- **WSL2 mirrored networking**: `networkingMode=mirrored` in `.wslconfig`
- **Port forwarding**: `netsh interface portproxy` to forward port 3000

Both require a Windows Firewall inbound rule for TCP 3000.

---

## 4. Error Recovery

### 4.1 CDP Disconnection

1. CdpClient detects WebSocket close
2. CDP Bridge emits `disconnected` → State Manager → clients see "Disconnected"
3. Reconnection loop with exponential backoff (1s, 2s, 4s... up to 30s)
4. On reconnect: re-discover targets, re-connect, resume polling

### 4.2 DOM Extraction Failure

1. Extraction catches all errors, returns `null`
2. State Manager treats `null` as "no change" (keeps last known state)
3. After 10 consecutive nulls, logs warning suggesting `npm run discover`

### 4.3 Client Disconnection

1. socket.io auto-reconnects with exponential backoff
2. On reconnect, server sends `state:full` to catch up

### 4.4 Command Execution Failure

1. Command Executor retries up to 2 times with 500ms delay
2. Returns `{ ok: false, error }` to the specific client
3. Client shows error toast

---

## 5. File Structure

```
cursor-ide-remote/
├── docs/
│   ├── initial_prd.md            # Original requirements (preserved)
│   ├── prd.md                    # Comprehensive PRD (this project's spec)
│   ├── architecture.md           # This document
│   ├── telegram_prd.md           # Telegram module PRD
│   └── telegram_architecture.md  # Telegram module architecture
├── temp/                         # Saved DOM snapshots for analysis
│   ├── full.html                 # Full Cursor window DOM
│   ├── chat.html                 # Chat panel DOM only
│   ├── plan_widget.html          # Plan widget DOM snapshot
│   ├── run_widget.html           # Run command widget DOM snapshot
│   └── workbench.desktop.main.css  # Cursor's CSS
├── src/
│   ├── server/
│   │   ├── index.ts              # Entry point: wiring + startup
│   │   ├── config.ts             # Environment config + selector loading
│   │   ├── types.ts              # All shared TypeScript interfaces
│   │   ├── cdp-client.ts         # Lightweight CDP client (raw WebSocket)
│   │   ├── cdp-bridge.ts         # CDP connection lifecycle + reconnection
│   │   ├── dom-extractor.ts      # DOM polling + ChatElement extraction
│   │   ├── command-executor.ts   # CDP action translation
│   │   ├── state-manager.ts      # State diffing + event emission
│   │   ├── relay.ts              # Web transport: Express + socket.io
│   │   └── transports/
│   │       ├── types.ts          # Transport interface
│   │       └── telegram/
│   │           ├── index.ts      # TelegramTransport class
│   │           ├── formatter.ts  # ChatElement → Telegram HTML
│   │           ├── commands.ts   # Bot command handlers
│   │           ├── topic-manager.ts  # Topic ↔ window+tab mapping
│   │           └── message-tracker.ts  # Element → message ID tracking
│   ├── client/
│   │   ├── index.html            # SPA shell
│   │   ├── app.js                # Client logic (socket.io, per-type rendering)
│   │   └── styles.css            # Cursor-themed dark styles
│   └── discovery/
│       └── discover-dom.ts       # DOM structure discovery CLI
├── extension/
│   ├── src/
│   │   ├── extension.ts           # VS Code extension entry point
│   │   ├── server-manager.ts      # Child process lifecycle + health polling
│   │   ├── license-manager.ts     # License validation + buy link
│   │   ├── status-bar.ts          # Status bar item
│   │   ├── output-channel.ts      # OutputChannel wrapper
│   │   ├── config-bridge.ts       # VS Code settings → env vars
│   │   └── tree-view.ts           # Sidebar TreeDataProvider
│   ├── media/
│   │   └── icon.png               # Extension icon
│   ├── esbuild.js                 # Extension bundler config
│   └── tsconfig.json              # Extension-specific tsconfig
├── scripts/
│   ├── dev-wrapper.ts             # Dev startup (license prompt)
│   └── release.ts                 # Version bump + changelog + tag
├── selectors.json                # Externalized DOM selectors (user-editable)
├── package.json
├── tsconfig.json
├── CHANGELOG.md
├── .vscodeignore
└── .gitignore
```

---

## 6. Implementation Discoveries

Lessons learned while building and debugging the CDP integration with Cursor's DOM. These are useful for anyone extending the system or troubleshooting after a Cursor version update.

### 6.1 Chat Tabs Use `.agent-sidebar-cell`

Chat tabs are extracted from `.agent-sidebar-cell` elements in Cursor's sidebar. These represent the agent chat history entries. Each cell has an `aria-label` or `title` attribute containing the chat name. The `data-selected` or `data-highlighted` attribute indicates the active tab. Switching is done by title-based matching and JS `.click()` — never via fragile CSS selector paths or coordinate-based CDP mouse events.

**Note**: The VS Code tablist (`ul[role="tablist"] li.composite-bar-action-tab`) contains editor/terminal/output tabs and must NOT be used for chat tabs.

### 6.2 CSS Selector Paths Must Escape Dots in IDs

Cursor's workbench uses element IDs with dots (e.g., `workbench.parts.auxiliarybar`). When building CSS selector paths via `buildSelectorPath`, these must be escaped: `#workbench\\.parts\\.auxiliarybar`. Without escaping, `querySelector` interprets the dot as a class selector and fails silently.

### 6.3 Dropdown Interaction: JS `.click()` Works, CDP Mouse Events Don't

Both mode and model dropdowns are opened and their items selected using plain JavaScript `.click()` calls via `Runtime.evaluate`. CDP `Input.dispatchMouseEvent` (coordinate-based mouse events) was found to be unreliable for these elements — clicks would appear to succeed but not register with React's event handlers, causing the dropdown to not open or the selection to not apply.

The working pattern (used by both `setMode` and `setModel`):
1. `document.querySelector(trigger).click()` — opens the dropdown
2. Wait 250-300ms for the menu to render
3. `document.querySelector(item).click()` — selects the item
4. Verify the menu closed (confirms selection was accepted)

### 6.4 Model Picker: Hover vs. Active State

In Cursor's model picker menu, `data-is-selected="true"` indicates the **hovered/focused** item, not the currently active model. The actually active model is indicated by a checkmark icon (`codicon-check`) in the item's right-side container. The model trigger button (`.composer-unified-dropdown-model`) shows the active model name as text.

### 6.5 Mode Extraction

The current mode (Agent, Plan, Debug, Ask) is stored as a `data-mode` attribute on the `.composer-unified-dropdown` element. Mode items in the dropdown have IDs following the pattern `composer-mode-*-{modeId}`.

---

### 6.6 Plan Widget Uses `.composer-create-plan-container`

The rich plan widget (with todo list, Build button, View Plan button) is nested inside a `data-message-kind="tool"` wrapper under `.composer-tool-former-message`. It must be detected BEFORE the generic compact tool summary extraction. Key selectors: `.composer-create-plan-title`, `.composer-create-plan-label`, `.composer-create-plan-todo-item`, `.composer-create-plan-build-button`, `.composer-create-plan-view-plan-button`.

The legacy plan format (`.plan-execution-message-content`) has a different DOM structure and appears inside `role=human` wrappers. Both are mapped to the `PlanBlock` type.

For remote control, the web client no longer relies only on the compact extracted widget payload:

- `View Plan` opens a local web modal.
- The relay can read `~/.cursor/plans/<label>` and return the full plan body/todos, matching Telegram's richer full-plan rendering when the saved file exists.
- The plan model pill requests the live Cursor dropdown options through the relay, then sends the chosen option back to Cursor without forcing the user to interact with the desktop UI directly.

### 6.7 Run Command Widget Uses `.composer-terminal-tool-call-block-container`

Terminal command approval cards contain the full shell command, a description header, and Run/Skip/Allow buttons. The container class is `.composer-terminal-tool-call-block-container` (or `.composer-tool-call-container.composer-terminal-compact-mode`). The command text is in `.composer-terminal-command-expanded-text`. Buttons are identified by `.composer-run-button` and `.composer-skip-button`. "Allow" buttons appear for sandbox permission requests.

Note: "Skip" was not previously in `rejectButton.textMatch` in `selectors.json` and must be added.

### 6.8 Generic Tool Action Extraction

All tool types — including Fetch, Edit review, terminal commands, and any future Cursor tool widgets — share a common button convention: `.composer-skip-button` for Skip and `.composer-run-button` / `.anysphere-secondary-button` for Run/Allow/Accept. The `extractToolActions(container)` helper in `dom-extractor.ts` generically scans any tool container for these buttons and classifies them as `skip`, `run`, or `allow`. This avoids per-tool-type button extraction code and ensures new tool types automatically surface their approval actions in both Telegram and the web app.

The compact tool path (`.composer-tool-former-message`) targets `.composer-tool-call-header-content` for action/detail text to avoid picking up button labels as content.

### 6.9 Browser Notifications

The web client fires native `Notification` API alerts when the browser tab is not focused and an actionable event appears. Covered events:
- Global approvals (from `pendingApprovals`)
- Run command prompts (messages with `type: 'run_command'` and actions)
- Tool-level approvals (messages with `type: 'tool'` and actions, e.g. Fetch allowlisting, Edit accept)

Each notification uses a unique tag per message ID to prevent duplicates. Permission is requested lazily on the first trigger.

---

## 7. VS Code Extension Shell

The project can also be installed as a VS Code / Cursor extension. The extension is a thin wrapper — it spawns the existing server as a child process and provides native editor integration.

Full specification: `docs/extension_prd.md`.

### 7.1 Architecture

The extension runs in the Extension Host (a Node.js process). It communicates with the server via:
1. **Environment variables** — configuration and license key passed at spawn time
2. **HTTP polling** — `GET /health` every 5 seconds for status data
3. **stdout/stderr parsing** — server log lines piped to a `LogOutputChannel`

The extension never imports server modules. License validation logic is duplicated intentionally — the extension bundle cannot share code with the server.

**Singleton server pattern:** Only one server process runs across all Cursor windows. On startup, `ServerManager` probes `GET /health` on the configured port. If a server is already running, the window attaches as an **observer** (polling health without owning the process). If not, it spawns the server and becomes the **owner**. If the owner window closes:

1. Observers detect 3 consecutive failed health polls
2. After a random jitter (0–3s) to prevent races, one observer calls `attemptTakeover()`
3. It spawns a new server process and becomes the new owner
4. Other observers detect the healthy server and remain observers

Race conditions during simultaneous spawns are handled by catching `EADDRINUSE` from stderr and falling back to observer mode.

### 7.2 Components

| File | Responsibility |
| --- | --- |
| `extension/src/extension.ts` | Activate/deactivate, command registration, auto-start, password generation |
| `extension/src/server-manager.ts` | Singleton lifecycle: spawn/kill, owner/observer, health polling, auto-recovery |
| `extension/src/license-manager.ts` | Validate key, VS Code Secrets API storage, buy link |
| `extension/src/config-bridge.ts` | Read VS Code settings → env vars for child process |
| `extension/src/status-bar.ts` | Status bar item with connection state colors |
| `extension/src/output-channel.ts` | `LogOutputChannel` wrapper with `info`/`warn`/`error` level support |
| `extension/src/tree-view.ts` | Sidebar TreeDataProvider: server status, Start/Stop buttons, CDP, agent, clients |
| `extension/src/setup-panel.ts` | WebviewPanel: networking config, password management, Telegram wizard |

### 7.3 Build

- **Extension bundle:** esbuild bundles `extension/src/extension.ts` → `dist/extension.cjs` (CJS format, external: `vscode`)
- **Server bundle:** esbuild bundles `src/server/index.ts` + all Node.js dependencies → `dist/server/bundle.mjs` (ESM format). A banner injects CJS compatibility shims (`__dirname`, `__filename`, `createRequire`) because bundled packages like Express rely on these globals.
- **Client files:** `tsc` compiles TypeScript, then `src/client/` is copied to `dist/client/` along with `socket.io.min.js` from node_modules.
- All steps run via `vscode:prepublish` before packaging with `vsce`.

### 7.4 Implementation Notes

**grammY native fetch:** The Telegram bot library (grammY) defaults to its own HTTP client based on `node:https`, which breaks in the esbuild-bundled ESM environment. The bot is constructed with `{ client: { fetch } }` to use Node.js's native `fetch` API instead.

**Webview lifecycle:** The Setup Panel webview uses `retainContextWhenHidden: true` for state preservation. Opening VS Code's Settings editor in the same ViewColumn while the webview is retained can deadlock Cursor's renderer. The "Open All Settings" handler disposes the panel first, then opens Settings on a deferred tick via `setTimeout`.

---

## 8. Extension-Specific Env Vars

These env vars are set by the extension when spawning the server as a child process. They are all backward-compatible — when absent, behavior is identical to standalone mode.

| Env Var | Default (standalone) | Extension sets | Purpose |
| --- | --- | --- | --- |
| `LICENSE_KEY` | not set → reads `data/license.key` | Key from VS Code secrets API | Pass license without file I/O |
| `DATA_DIR` | not set → `./data` | `context.globalStorageUri` | Persistent storage isolated from extension install dir |
| `LOG_FORMAT` | not set → timestamped plain text | `json` | Structured JSON lines for Output Channel parsing |

---

## 9. Dependencies

| Package            | Version | Purpose                                              |
| ------------------ | ------- | ---------------------------------------------------- |
| `express`          | ^4.21   | HTTP server for static files + health                |
| `socket.io`        | ^4.8    | Real-time bidirectional communication                |
| `ws`               | ^8.18   | Raw WebSocket for CDP client                         |
| `grammy`           | latest  | Telegram Bot API framework (TypeScript)              |
| `node-html-parser` | latest  | DOM-based HTML parsing for Telegram formatter        |
| `tsx`              | ^4.19   | Dev: TypeScript execution with watch mode            |
| `typescript`       | ^5.7    | Type checking and compilation                        |
| `@types/vscode`    | ^1.85   | Dev: VS Code extension API types                     |
| `esbuild`          | ^0.24   | Dev: Extension bundling                              |
| `@vscode/vsce`     | ^3.0    | Dev: Extension packaging and publishing              |

No Puppeteer. No frontend framework. No build tools for the client.

