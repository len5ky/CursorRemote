# CursorRemote — Extension PRD

## 1. Overview

Package the CursorRemote relay server as a VS Code / Cursor extension. The extension wraps the server as a managed child process and provides native editor integration: settings UI, setup wizard, status bar, output channel, sidebar tree view, license management, and multi-window coordination. The server code, web client, and Telegram transport are bundled into the extension and run as a single child process. The bundled **web client** renders assistant **`codeBlocks`** and tool **`diffBlock`** as native code/diff UI (~7-line scroll viewport, full-screen reader, mobile touch targets; see `docs/prd.md` §6.11 and `docs/architecture.md` §2.6).

### 1.1 Problem Statement

The standalone server requires manual setup: cloning a repo, installing dependencies, creating an `.env` file, and running `npm run dev`. Users must manage process lifecycle themselves. There is no in-editor visibility into server status, CDP connection health, or agent activity. Multi-window scenarios cause port conflicts and duplicate bot instances.

### 1.2 Goals

Ship a VS Code / Cursor extension that:

- Installs from a `.vsix` file (marketplace listing planned)
- Manages the relay server lifecycle (start/stop/restart) automatically
- Provides all configuration via VS Code Settings (no `.env` file needed)
- Offers an interactive Setup Panel for networking, password, and Telegram configuration
- Shows server and CDP connection status in the status bar and sidebar
- Pipes server logs to a LogOutputChannel with built-in level filtering
- Displays agent status, windows, and quick actions in a sidebar tree view with Start/Stop controls
- Handles license key entry non-intrusively via the sidebar
- Auto-generates a cryptographically random web client password on first install
- Runs a single server instance across multiple Cursor windows (singleton pattern)
- Bundles all server dependencies into a single file (no `node_modules` needed)
- Preserves 100% backward compatibility with standalone `npm run dev` usage

### 1.3 Non-Goals

- Rewriting the server to run inline in the Extension Host
- Replacing CDP-based DOM extraction with VS Code extension APIs
- Automatic discovery or configuration of the CDP debug port

---

## 2. User Stories

### US-1: Install and Go
**As a** Cursor user, **I want to** install the extension from a `.vsix` file, enter my license key, and have the server running, **so that** I don't need to clone a repo, install dependencies, or edit config files.

### US-2: Auto-Start
**As a** developer, **I want** the relay server to start automatically when Cursor launches, **so that** my phone client and Telegram bot are always available without manual intervention.

### US-3: Settings UI
**As a** developer, **I want to** configure CDP URL, server port, Telegram settings, and other options in VS Code Settings with inline documentation links, **so that** I don't need to edit `.env` files.

### US-4: Setup Wizard
**As a** new user, **I want** an interactive Setup Panel that walks me through networking, password, and Telegram configuration, **so that** I can get started without reading documentation.

### US-5: Status Visibility
**As a** developer, **I want to** see server status, CDP connection, agent activity, and connected clients in the sidebar and status bar, **so that** I know the system is working at a glance.

### US-6: Server Control
**As a** developer, **I want** Start and Stop buttons in the sidebar, **so that** I can control the server without opening the Command Palette.

### US-7: License Management
**As a** user, **I want** the license prompt to be non-intrusive — shown in the sidebar with a "Buy" link, **so that** I'm not interrupted by popups on every startup.

### US-8: Auto-Generated Password
**As a** new user, **I want** a strong random password generated for me on first install, **so that** the web client is secure by default without manual configuration.

### US-9: Multi-Window Safety
**As a** developer with multiple Cursor windows, **I want** only one server running at a time with automatic recovery, **so that** I don't get port conflicts or duplicate Telegram bots.

### US-10: Server Logs
**As a** developer, **I want to** view server logs in the Output panel with level filtering, **so that** I can debug issues without switching to a terminal.

---

## 3. Architecture

The extension runs in the VS Code Extension Host (a Node.js process). It spawns the server as a child process and communicates via:

1. **Environment variables** — configuration and license key passed at spawn time
2. **HTTP polling** — `GET /health` every 5 seconds for status data
3. **stdout/stderr parsing** — log lines piped to a LogOutputChannel

The server and all its Node.js dependencies are bundled into a single ESM file (`dist/server/bundle.mjs`) via esbuild. The extension itself is bundled into `dist/extension.cjs` (CJS format, external: `vscode`).

### 3.1 Singleton Server Pattern

Only one server process runs across all Cursor windows:

1. On startup, `ServerManager` probes `GET /health` on the configured port
2. If a server is already running, the window attaches as an **observer** (polls health, shows status, but doesn't own the process)
3. If not running, the window spawns the server and becomes the **owner**
4. If the owner window closes, observers detect 3 failed health polls, then one observer takes over after a random jitter (0–3s) to prevent races
5. Race conditions during simultaneous spawns are handled by catching `EADDRINUSE` from stderr and falling back to observer mode

---

## 4. Extension Commands

| Command ID | Title | Description |
|---|---|---|
| `cursorRemote.start` | CursorRemote: Start Server | Start the relay server |
| `cursorRemote.stop` | CursorRemote: Stop Server | Stop the relay server |
| `cursorRemote.restart` | CursorRemote: Restart Server | Restart the relay server |
| `cursorRemote.openWebClient` | CursorRemote: Open Web Client | Open the browser client URL |
| `cursorRemote.openSetup` | CursorRemote: Open Setup Panel | Open the networking and Telegram setup wizard |
| `cursorRemote.showLogs` | CursorRemote: Show Logs | Show the Output Channel |
| `cursorRemote.enterLicenseKey` | CursorRemote: Enter License Key | Prompt for a license key |
| `cursorRemote.buyLicense` | CursorRemote: Buy License | Open the store URL (with UTM tags) |

---

## 5. Extension Settings

All settings are under the `cursorRemote` namespace. Each maps 1:1 to a server env var. Settings use `markdownDescription` with links to GitHub documentation.

| Setting | Type | Default | Env Var | Description |
|---|---|---|---|---|
| `cursorRemote.autoStart` | boolean | `true` | — | Auto-start server on launch |
| `cursorRemote.cdpUrl` | string | `http://127.0.0.1:9222` | `CDP_URL` | Cursor's CDP endpoint |
| `cursorRemote.serverPort` | number | `3000` | `SERVER_PORT` | Web server port |
| `cursorRemote.serverHost` | string | `127.0.0.1` | `SERVER_HOST` | Bind address (localhost-only by default) |
| `cursorRemote.pollIntervalMs` | number | `500` | `POLL_INTERVAL_MS` | DOM polling frequency |
| `cursorRemote.debounceMs` | number | `300` | `DEBOUNCE_MS` | Broadcast debounce |
| `cursorRemote.logLevel` | enum | `info` | `LOG_LEVEL` | Log level |
| `cursorRemote.webappPassword` | string | *(auto-generated)* | `WEBAPP_PASSWORD` | Password for web client |
| `cursorRemote.windowTitleQualifier` | boolean | `true` | `WINDOW_TITLE_QUALIFIER` | Show remote qualifier in titles |
| `cursorRemote.telegram.enabled` | boolean | `false` | `TELEGRAM_ENABLED` | Enable Telegram |
| `cursorRemote.telegram.botToken` | string | `""` | `TELEGRAM_BOT_TOKEN` | Bot token |
| `cursorRemote.telegram.allowedUsers` | string | `""` | `TELEGRAM_ALLOWED_USERS` | Comma-separated IDs |

### 5.1 Security Defaults

- `serverHost` defaults to `127.0.0.1` (not `0.0.0.0`) so the server is never exposed to the network until the user explicitly opts in via the Setup Panel
- `webappPassword` is auto-generated on first activation using `crypto.randomBytes(24)` and stored in VS Code Settings. The user is shown a non-blocking notification with a "Copy to Clipboard" action.

---

## 6. Status Bar

Left-aligned status bar item showing server state:

| State | Text | Color | Condition |
|---|---|---|---|
| Running | `$(radio-tower) Remote: Running` | Green | Server healthy + CDP connected |
| Disconnected | `$(radio-tower) Remote: Disconnected` | Yellow | Server running, CDP not connected |
| Stopped | `$(radio-tower) Remote: Stopped` | Default | Server not running |
| Error | `$(radio-tower) Remote: Error` | Red | Server crashed or unreachable |

Click opens the CursorRemote sidebar panel (not the command palette).

---

## 7. Sidebar Tree View

Activity bar view container `cursorRemote` with a `TreeDataProvider` showing:

### When unlicensed:
- **License Key Required** (click to activate) — error-colored key icon
- **Buy License** — links to store with UTM tags
- **Open Setup Panel** — gear icon

### When licensed, server running:
- **Server: Running** — green check icon, uptime in description, "observer" tag for non-owner windows
- **Stop Server** — stop icon button
- **CDP: Connected** — plug icon, active workspace name
- **Agent** — status (idle/running_tool/etc.), mode/model
- **Clients** — connected browser session count
- **Pending Approvals** — badge count (hidden when 0)
- **Windows** — discovered Cursor window count with names
- *(separator)*
- **Open Setup Panel** — gear icon
- **Open Web Client** — external link icon
- **Show Logs** — output icon

### When licensed, server stopped:
- **Server: Stopped** — "click to start"
- **Start Server** — play icon button
- *(separator)*
- **Open Setup Panel**, **Open Web Client**, **Show Logs**

Refreshed on health poll events and server state changes.

---

## 8. Setup Panel (WebviewPanel)

Interactive configuration wizard opened via `cursorRemote.openSetup`. Created in `ViewColumn.One` with `retainContextWhenHidden: true`.

### Networking Tab
- **Radio group**: Localhost / LAN / Specific address (Tailscale/custom)
- Custom address text input (shown when "Specific address" selected)
- **Save & Restart** button — updates settings and restarts server
- Tailscale documentation link

### Password Section
- Editable text input with current password
- **Copy** and **Save** buttons
- Server URL displayed for reference

### Telegram Tab
- **Step 1: Create Bot** — link to @BotFather, token input (or masked display if already set)
- **Step 2: Create Supergroup** — instructions for Topics and admin setup
- **Step 3: Register** — displays the actual `/register <token>` command from `telegram-auth.json`, copyable. Shows registered users and usernames.
- **Step 4: Sync** — instructions to send `/sync`

### Footer
- **Open All Settings** button — disposes the webview panel first, then opens VS Code Settings filtered to `@ext:cursor-remote.cursor-remote` on a deferred tick (avoids Cursor renderer freeze from retained webview + settings editor conflict)

---

## 9. License Flow

1. On activation, extension reads key from `context.secrets`
2. If valid: start server (if `autoStart` enabled)
3. If missing/invalid: sidebar shows "License Key Required" item (non-intrusive — no popup)
4. User clicks to enter key via `showInputBox` with format validation
5. Valid key stored in `context.secrets.store('cursorRemote.licenseKey', key)`
6. Key passed to server child process via `LICENSE_KEY` env var
7. Server's own `checkLicense()` validates independently (defense-in-depth)
8. "Buy License" in sidebar opens the store URL with UTM tracking (`?utm_source=extension&utm_medium=sidebar&utm_campaign=license`)

---

## 10. Getting Started Walkthrough

A `contributes.walkthroughs` entry provides a step-by-step onboarding flow:

1. **Enter License Key** — with command link and buy link (UTM-tagged)
2. **Verify CDP Connection** — instructions for `--remote-debugging-port=9222`, start server command
3. **Configure Networking** — open Setup Panel command
4. **Set Up Telegram** — optional, open Setup Panel command
5. **Done** — summary with link to documentation

---

## 11. Server-Side Enhancements

Backward-compatible changes to support the extension:

### 11.1 Richer `/health` endpoint
Returns `windows`, `activeWindowId`, `mode`, `model`, `chatTabCount`, `pendingApprovalCount`, `generation`, `uptime`, `authRequired`. Existing clients ignore unknown fields.

### 11.2 `LICENSE_KEY` env var
Read license key from `process.env.LICENSE_KEY` before falling back to `data/license.key` file.

### 11.3 `DATA_DIR` env var
Configurable data directory (default: `./data`). Extension sets this to `context.globalStorageUri.fsPath`.

### 11.4 `LOG_FORMAT` env var
When set to `json`, emit structured JSON lines to stdout.

### 11.5 Cache-busting static serving
`GET /` dynamically reads `index.html` and injects `?v=<random>` query parameters on `app.js` and `styles.css` tags. Static files served with `Cache-Control: no-cache, must-revalidate`.

### 11.6 Auth middleware ordering
`/health` and static files are served before the auth middleware, preventing redirect loops when the web client checks authentication state.

### 11.7 grammY native fetch
The Telegram bot is constructed with `{ client: { fetch } }` to use Node.js's native `fetch` API. grammY's default HTTP client (based on `node:https` / `node-fetch`) breaks in the esbuild-bundled ESM environment.

### 11.8 Graceful Telegram shutdown
`bot.stop()` is awaited with a 3-second timeout during server shutdown, ensuring the long-polling session is cleanly closed and the next server instance can connect immediately.

### 11.9 Telegram connectivity diagnostics
On startup, the server tests outbound HTTPS with raw `fetch` to `api.telegram.org/bot<token>/getMe` and `deleteWebhook`. If unreachable, it tests `google.com` to distinguish between Telegram-specific blocks and general network issues.

---

## 12. Build and Distribution

### 12.1 Extension Build
- esbuild bundles `extension/src/extension.ts` → `dist/extension.cjs`
- Format: CommonJS, platform: Node, external: `['vscode']`

### 12.2 Server Build
- esbuild bundles `src/server/index.ts` + all Node.js dependencies → `dist/server/bundle.mjs`
- Format: ESM, platform: Node
- Banner injects CJS compatibility shims (`__dirname`, `__filename`, `createRequire`) for bundled packages (Express, etc.) that rely on these globals
- No `node_modules` needed in the extension package

### 12.3 Client Build
- `tsc` compiles TypeScript
- `src/client/` copied to `dist/client/`
- `socket.io.min.js` copied from `node_modules` to `dist/client/`

### 12.4 Packaging
- `npm run package` bumps the patch version, then runs `vsce package --no-dependencies`
- Output: `releases/cursor-remote-X.Y.Z.vsix`
- `.vscodeignore` includes only: `dist/extension.cjs`, `dist/server/bundle.mjs`, `dist/client/`, `extension/media/walkthrough/`, `selectors.json`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`

### 12.5 Version Bumping
- `npm run package` auto-increments the patch version via `scripts/bump-build.ts`
- `npm run release -- patch|minor|major` bumps semantic version, updates changelog, creates a git tag

---

## 13. Backward Compatibility

Every enhancement is gated behind an env var that defaults to existing behavior:

| Env var | Default (standalone) | Extension sets |
|---|---|---|
| `LICENSE_KEY` | not set → reads `data/license.key` | key from Secrets API |
| `DATA_DIR` | not set → `./data` | `context.globalStorageUri.fsPath` |
| `LOG_FORMAT` | not set → plain text | `json` |

Standalone `npm run dev` and `npm start` work identically to before. The `.env` file, `data/` directory, and all CLI behavior are unchanged.
