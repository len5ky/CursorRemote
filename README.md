# CursorRemote

Remote control for your local Cursor AI agent — monitor sessions, approve steps, and send tasks from your phone, tablet, or another computer's browser, or via Telegram, while Cursor runs on your machine.

<div align="center">

| Mobile web app | Telegram |
|:-:|:-:|
| <img src="media/web-app.gif" alt="Mobile web app" width="300"> | <img src="media/telegram.gif" alt="Telegram integration" width="300"> |

<p><b>Extension UI</b> — CursorRemote sidebar: server status, CDP connection, agent state, and start/stop</p>
<img src="media/extension_tab.png" alt="CursorRemote extension sidebar with server controls and status" width="380">

</div>

## Features

- **Mobile Web Client** -- real-time chat view with Cursor's dark theme, approve/reject buttons, plan widgets, run command cards, mode/model switching
- **Telegram Integration** -- auto-sync conversations into forum topics, approve via inline buttons, send prompts from any device
- **Multi-Window Monitoring** -- all Cursor windows polled in parallel via separate CDP connections (no UI switching)
- **Auto-Topic Creation** -- new chat tabs automatically get a Telegram topic created
- **VS Code Extension** -- integrated sidebar with server status, start/stop controls, setup wizard, and settings
- **Persistent State** -- messages, topics, sync, and auth all survive server restarts

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Cursor Extension (optional)                                    │
│  Spawns server, provides UI, manages lifecycle                  │
│                                                                 │
│  Cursor IDE  ──CDP──>  Relay Server  ──socket.io──>  Browser    │
│  (Windows/Mac)          (Node.js)     ──Bot API───>  Telegram   │
└─────────────────────────────────────────────────────────────────┘
```

1. **Cursor IDE** runs with Chrome DevTools Protocol enabled (`--remote-debugging-port=9222`)
2. **Relay Server** connects via CDP, extracts agent chat state from the DOM
3. **Window Monitor** polls all windows in parallel using separate CDP connections
4. **Browser Client** displays the conversation in real time on any device
5. **Telegram Bot** (optional) mirrors data into auto-created forum topics

## Which Setup Should I Use?

| | Extension (recommended) | Standalone |
|---|---|---|
| **Best for** | Daily use on your dev machine | Headless servers, CI, or manual configuration |
| **Install** | One `.vsix` file | Clone repo + `npm install` |
| **Configuration** | VS Code Settings + Setup Panel | `.env` file |
| **Server lifecycle** | Auto-starts, sidebar Start/Stop | Manual `npm run dev` or `npm start` |
| **Status UI** | Sidebar panel with live status | Terminal logs + `/health` endpoint |
| **Password** | Auto-generated on first install | Manual in `.env` |
| **Multi-window** | Singleton — one server across all windows | Single process |

---

## Setup A: Extension (Recommended)

### 1. Install the Extension

Download the latest `.vsix` from [releases](https://github.com/len5ky/CursorRemote/releases), then install:

```bash
# From the command line
cursor --install-extension cursor-remote-0.1.39.vsix
```

Or in Cursor: open the Command Palette (`Ctrl+Shift+P`), run **Extensions: Install from VSIX...**, and select the file.

### 2. Enter Your License Key

Open the **CursorRemote** panel in the activity bar (left sidebar). You'll see a "License Key Required" prompt — click it to enter your key. It's stored securely in the OS credential store via VS Code's Secrets API.

Don't have a key? Get one from the [store](https://cursor-remote.com/buy?utm_source=github&utm_medium=readme&utm_campaign=license).

### 3. Launch Cursor with CDP Enabled

Add `--remote-debugging-port=9222` to your Cursor shortcut, or run:

```powershell
# Windows
& "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9222
```

```bash
# macOS
open -a Cursor --args --remote-debugging-port=9222
```

```bash
# Linux
cursor --remote-debugging-port=9222
```

**Important:** Fully quit and restart Cursor after adding the flag. On macOS use Cmd+Q (not just close the window). Verify: `http://localhost:9222/json` should return JSON.

### 4. Server Auto-Starts

The extension automatically starts the relay server when Cursor launches. Check the **CursorRemote** sidebar panel for live status:

- **Server status** -- Running / Stopped / Disconnected
- **CDP connection** -- Connected / Disconnected with active workspace name
- **Agent status** -- idle, running tool, etc. with current mode and model
- **Connected clients** -- number of browser sessions
- **Start / Stop buttons** -- control the server directly from the sidebar

If it doesn't auto-start, click **Start Server** in the sidebar or run **CursorRemote: Start Server** from the Command Palette.

### 5. Configure Networking and Connect

Run **CursorRemote: Open Setup Panel** (or click **Open Setup Panel** in the sidebar) to configure:

- **Networking** -- choose Localhost (default), LAN (all interfaces), or a specific IP (Tailscale)
- **Web Client Password** -- auto-generated on first install; copy it or set your own
- **Telegram** -- step-by-step wizard with bot token entry, registration token display, and user status

Open `http://<server-ip>:<port>` in any browser on your phone, tablet, or another computer and enter the password.

> **Multi-window:** Only one server instance runs across all Cursor windows. The first window to start becomes the owner; other windows attach as observers and auto-recover if the owner closes.

### Extension Commands

| Command | Description |
|---------|-------------|
| `CursorRemote: Start Server` | Start the relay server |
| `CursorRemote: Stop Server` | Stop the relay server |
| `CursorRemote: Restart Server` | Restart the relay server |
| `CursorRemote: Open Web Client` | Open the browser client URL |
| `CursorRemote: Open Setup Panel` | Open the networking and Telegram setup wizard |
| `CursorRemote: Show Logs` | Show server logs in Output panel |
| `CursorRemote: Enter License Key` | Enter and store a license key |
| `CursorRemote: Buy License` | Open the store URL |

### Extension Settings

All settings are under `cursorRemote.*` in VS Code Settings. Each setting includes inline documentation with links to relevant guides.

| Setting | Default | Description |
|---------|---------|-------------|
| `autoStart` | `true` | Auto-start server on launch |
| `cdpUrl` | `http://127.0.0.1:9222` | Cursor's CDP endpoint |
| `serverPort` | `3000` | Web server port |
| `serverHost` | `127.0.0.1` | Bind address (localhost-only by default) |
| `pollIntervalMs` | `500` | DOM polling frequency (ms) |
| `debounceMs` | `300` | Broadcast interval (ms) |
| `logLevel` | `info` | Server log level |
| `webappPassword` | *(auto-generated)* | Password for the web client |
| `windowTitleQualifier` | `true` | Include remote qualifier in titles |
| `telegram.enabled` | `false` | Enable Telegram bot |
| `telegram.botToken` | -- | Bot token from @BotFather |
| `telegram.allowedUsers` | -- | Comma-separated allowed user IDs |

---

## Setup B: Standalone Server (Without Extension)

Run the relay server directly from the command line — useful for headless machines, remote servers, or if you prefer managing configuration via `.env` files.

### Prerequisites

- Node.js 20+
- Cursor IDE with `--remote-debugging-port=9222`
- A browser on the same network (for the web client)

### Install and Run

```bash
git clone https://github.com/len5ky/CursorRemote.git cursor-ide-remote
cd cursor-ide-remote
npm install
cp .env.example .env
npm run dev
```

On first run, you'll be prompted for a **license key**. Get one from the [store](https://cursor-remote.com/buy?utm_source=github&utm_medium=readme_standalone&utm_campaign=license). The key is saved to `data/license.key`.

Edit `.env` to configure the server. For Telegram, set `TELEGRAM_ENABLED=true` and `TELEGRAM_BOT_TOKEN`.

### Standalone Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CDP_URL` | `http://127.0.0.1:9222` | Cursor's CDP endpoint |
| `SERVER_PORT` | `3000` | Web server port |
| `SERVER_HOST` | `127.0.0.1` | Bind address |
| `POLL_INTERVAL_MS` | `500` | DOM polling frequency (ms) |
| `DEBOUNCE_MS` | `300` | Broadcast interval (ms) |
| `LOG_LEVEL` | `info` | Log level |
| `WEBAPP_PASSWORD` | -- | Password for the web UI |
| `TELEGRAM_ENABLED` | `false` | Enable Telegram bot |
| `TELEGRAM_BOT_TOKEN` | -- | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS` | -- | Comma-separated allowed user IDs |
| `LICENSE_KEY` | -- | License key via env (overrides file) |
| `DATA_DIR` | `./data` | Data directory for persistent state |
| `LOG_FORMAT` | `text` | Set to `json` for structured log lines |

### Production

```bash
npm run build
npm start
```

Ensure `data/license.key` exists before running `npm start` (no interactive prompt in production mode).

> **WSL2 users**: see [Setup Guide](docs/setup-guide.md) for port forwarding details.

---

## Security

CursorRemote ships with secure defaults out of the box:

- **Localhost-only** -- the server binds to `127.0.0.1` by default, so it's never exposed to the network until you explicitly choose to.
- **Auto-generated password** (extension) -- a cryptographically random password is created on first install and used to protect the web client.
- **Encrypted key storage** (extension) -- your license key and password are stored in the OS credential store via VS Code's Secrets API.

### Accessing from another device

**Option A: Tailscale (recommended)** -- install [Tailscale](https://tailscale.com/) on your computer and phone. Your server is accessible over a private WireGuard mesh with no port forwarding needed. See the [Tailscale setup guide](docs/tailscale-setup.md).

**Option B: LAN access** -- open the **Setup Panel** (extension) or set `SERVER_HOST=0.0.0.0` (standalone). The server binds to all interfaces and requires a password.

Both options can be combined for defense in depth.

## Privacy

CursorRemote is **100% self-hosted**. There is no phone-home, no telemetry, no analytics, no usage tracking. The software never connects to our servers — not at startup, not during use, not ever. License validation happens entirely offline against your local key. Your code, your conversations, and your agent activity stay on your machine and your network. We don't see any of it.

## Telegram Setup

The easiest way to set up Telegram is via the **Setup Panel** — run **CursorRemote: Open Setup Panel** and switch to the Telegram tab for a step-by-step wizard that shows your registration token and registered users.

### Manual Setup

1. **Create a bot**: Message `@BotFather` > `/newbot` > copy the token
2. **Configure**: Set `cursorRemote.telegram.botToken` in VS Code Settings (extension) or `TELEGRAM_BOT_TOKEN` in `.env` (standalone), and enable Telegram
3. **Create a group**: Create a Telegram supergroup with Topics enabled, add bot as admin with Manage Topics permission
4. **Register**: Start the server, check the Output panel (extension) or terminal (standalone) for the registration token, send `/register <token>` in the group
5. **Sync**: Send `/sync` to enable auto-sync. Topics are auto-created for each window + chat tab.

### Bot Commands

| Command | Description |
|---------|-------------|
| `/register <token>` | Register yourself (token shown in server output) |
| `/sync` | Enable auto-sync (active tabs get topics + last 5 messages) |
| `/sync_all` | Create topics for ALL tabs in all windows |
| `/unsync` | Disable sync, delete tracked topics |
| `/cleanup` | Delete stale/untracked topics |
| `/purge` | Delete ALL topics (nuclear, runs in background) |
| `/status` | Connection, sync, group ID, agent info |
| `/history [N]` | Last N messages (default 30), scrolls chat to load more |
| `/mode` | Show/switch agent mode (switches to topic's window) |
| `/model` | Show current model |
| `/plan <text>` | Prompt in Plan mode |
| `/agent <text>` | Prompt in Agent mode |

Plain text in any topic is sent as a prompt to the mapped Cursor agent.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development with hot-reload (prompts for license key if missing) |
| `npm run build` | Compile TS + copy client |
| `npm run build:ext` | Bundle the VS Code extension |
| `npm run watch:ext` | Watch-mode for extension development |
| `npm run package` | Bump patch version and package .vsix into `releases/` |
| `npm run release -- patch\|minor\|major` | Bump version, update changelog, create git tag |
| `npm start` | Run compiled server |
| `npm run discover` | DOM discovery tool |

## Documentation

- [Setup Guide](docs/setup-guide.md) -- installation, networking, Telegram, troubleshooting
- [Tailscale Setup](docs/tailscale-setup.md) -- secure remote access without exposing to the internet
- [Product Requirements](docs/prd.md) -- features, state model, protocol
- [Architecture](docs/architecture.md) -- components, data flow, decisions
- [Telegram PRD](docs/telegram_prd.md) -- message formats, commands
- [Telegram Architecture](docs/telegram_architecture.md) -- multi-window, queues, lifecycle
- [Extension PRD](docs/extension_prd.md) -- VS Code extension features, settings, build
