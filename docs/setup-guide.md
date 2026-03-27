# Setup Guide -- CursorRemote

## 1. Enable CDP on Cursor IDE

Cursor must be launched with the Chrome DevTools Protocol remote debugging port enabled. This is required for both extension and standalone setups.

### Windows: Shortcut (Recommended)

1. Right-click your Cursor desktop shortcut > Properties
2. In "Target", append ` --remote-debugging-port=9222`
3. Click OK

### macOS

```bash
open -a Cursor --args --remote-debugging-port=9222
```

Or create an alias in your shell profile:
```bash
alias cursor='open -a Cursor --args --remote-debugging-port=9222'
```

### Linux

```bash
cursor --remote-debugging-port=9222
```

### Important

**Fully quit and restart Cursor** after adding the flag. On macOS, use Cmd+Q (not just close the window) — Cursor runs in the background otherwise.

### Verify

Open `http://localhost:9222/json` in a browser. You should see a JSON array. If it doesn't work, make sure Cursor was fully restarted.

---

## 2A. Extension Setup (Recommended)

The CursorRemote extension provides the easiest setup experience with built-in status UI, auto-start, and a configuration wizard.

### Install

Download the latest `.vsix` from [releases](https://github.com/len5ky/CursorRemote/releases) and install:

```bash
cursor --install-extension cursor-remote-0.1.42.vsix
```

Or in Cursor: Command Palette (`Ctrl+Shift+P`) > **Extensions: Install from VSIX...** > select the file.

### License Key

Open the **CursorRemote** panel in the activity bar (left sidebar). Click "License Key Required" to enter your key. It's stored securely in the OS credential store.

Get a key from the [store](https://cursor-remote.com/buy?utm_source=github&utm_medium=setup_guide&utm_campaign=license).

### Server Lifecycle

The server auto-starts when Cursor launches (if `cursorRemote.autoStart` is `true`). The sidebar panel shows live status:

- **Server: Running / Stopped** -- with Start and Stop buttons
- **CDP: Connected** -- with the active workspace name
- **Agent status** -- current mode and model
- **Clients** -- number of connected browser sessions

You can also use Command Palette commands: **CursorRemote: Start Server**, **CursorRemote: Stop Server**.

### Networking and Password

Run **CursorRemote: Open Setup Panel** to configure:

1. **Server Bind Address** -- choose Localhost (127.0.0.1), LAN (0.0.0.0), or a specific IP for Tailscale
2. **Web Client Password** -- auto-generated on first install. Copy it from the Setup Panel or find it in Settings (`cursorRemote.webappPassword`). You can edit it directly.
3. Click **Save & Restart** to apply changes.

Open `http://<server-ip>:<port>` in any browser on your phone, tablet, or another computer.

### Web client — code and diffs

Assistant **code** and file-edit **diffs** are not copied as Cursor’s Monaco HTML. The relay sends structured **`codeBlocks`** / **`diffBlock`**; the UI shows a compact card (~**seven lines** with scroll inside the card, momentum scrolling on iOS). Tap the **expand** control to open a **full-screen** reader (large close control, tap outside or Escape to dismiss). This keeps long patches readable on small screens without dominating the chat.

### Web client -- plan widgets and connection states

Plan widgets in the web app now mirror the remote-control flow more closely:

- **View Plan** opens a web modal and loads the full saved plan file when available, not just the compact widget summary.
- **Plan model** opens a web picker with the real model options scraped from Cursor, then applies the selected option back in Cursor.
- **Build** still triggers the underlying Cursor action directly.

Connection labels are also more specific now. If the phone is still connected to the relay but Cursor/CDP extraction is stalled, the UI shows a waiting/extractor state instead of a generic browser disconnect. This is especially useful on macOS when backgrounded Cursor windows throttle CDP evaluation.

### Telegram (Extension)

Switch to the **Telegram** tab in the Setup Panel for a step-by-step wizard:

1. **Create a bot** -- paste the token from @BotFather
2. **Create a supergroup** -- enable Topics, add bot as admin
3. **Register** -- the panel shows the actual `/register <token>` command to copy
4. **Sync** -- send `/sync` in the group

The panel also shows registered users and their usernames.

### Multi-Window Behavior

Only one server instance runs across all Cursor windows:

- The first window to start becomes the **owner** and spawns the server process.
- Other windows detect the running server via health polling and attach as **observers**.
- If the owner window closes, an observer automatically takes over and spawns a new server.
- The sidebar shows "observer" next to the server status when a window is not the owner.

---

## 2B. Standalone Setup (Without Extension)

Run the relay server directly from the command line. Useful for headless machines, remote servers, or manual configuration via `.env` files.

### Install

```bash
git clone https://github.com/len5ky/CursorRemote.git cursor-ide-remote
cd cursor-ide-remote
npm install
cp .env.example .env
```

Edit `.env` -- the defaults work for the web client. For Telegram, set `TELEGRAM_ENABLED=true` and `TELEGRAM_BOT_TOKEN` (see section 5).

### Start the Server

```bash
npm run dev
```

**License key (first run only):** You'll be prompted for a license key. Get one from the [store](https://cursor-remote.com/buy?utm_source=github&utm_medium=setup_guide&utm_campaign=license). The key is saved to `data/license.key` and won't be asked again on subsequent runs. For production (`npm start`), ensure the key file exists before starting.

```
[main] CDP URL: http://127.0.0.1:9222
[main] Server: http://127.0.0.1:3000
[telegram] Bot connected (sync: off, users: 0)
[telegram] To register, send: /register A1B2C3D4
```

---

## 3. Network Access

> **Extension users:** The Setup Panel handles networking with a few clicks. The manual instructions below are primarily for standalone or WSL2-specific configurations.

### Default: Localhost Only

By default, the server binds to `127.0.0.1` and is only accessible from a browser on the same machine.

### LAN Access

Set the bind address to `0.0.0.0`:

- **Extension:** Open Setup Panel > Networking > select "LAN access (all interfaces)" > Save & Restart
- **Standalone:** Set `SERVER_HOST=0.0.0.0` in `.env`

Then open `http://<your-ip>:<port>` on your phone. A password is required.

### WSL2-Specific

If running on WSL2, the server is isolated from your LAN. You need one of:

#### Option A: Mirrored Networking (Recommended)

Add to `%UserProfile%\.wslconfig` on Windows:
```ini
[wsl2]
networkingMode=mirrored
```
Restart WSL2: `wsl --shutdown`

#### Option B: Port Forwarding

```powershell
# Find WSL2 IP
wsl hostname -I
# Forward port (PowerShell as Admin)
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=<WSL2-IP>
```

#### Windows Firewall

```powershell
New-NetFirewallRule -DisplayName "CursorRemote" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

### Secure Remote Access

**Tailscale (recommended)** -- access over a private VPN, no port forwarding needed. See [Tailscale Setup](tailscale-setup.md).

**Password protection** -- set a password in the Setup Panel (extension) or `WEBAPP_PASSWORD` in `.env` (standalone). Login is rate-limited to 10 attempts per minute per IP.

Both can be combined. See [Tailscale Setup](tailscale-setup.md) for details.

---

## 4. Telegram Integration (Optional)

> **Extension users:** The Setup Panel's Telegram tab provides a step-by-step wizard. The instructions below cover the manual process.

### 4.1 Create the Bot

1. Message `@BotFather` on Telegram > `/newbot` > follow prompts
2. Copy the **bot token**
3. **Disable privacy**: `@BotFather` > `/mybots` > Bot Settings > Group Privacy > **Turn OFF**

### 4.2 Configure

**Extension:** Open Setup Panel > Telegram tab > paste the bot token > Save Token. The extension enables Telegram automatically.

**Standalone:** Edit `.env`:
```bash
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4.3 Start the Server

The server prints the registration token on startup:

- **Extension:** Check the Output panel (CursorRemote channel) or the Setup Panel's Telegram tab
- **Standalone:** Check the terminal output

```
[telegram] To register, send in your Telegram group: /register A1B2C3D4
```

### 4.4 Set Up the Group

1. Create a Telegram group
2. Add your bot to the group
3. **Enable Topics**: Group Settings > Topics > Enable
4. **Make bot admin**: Group Settings > Administrators > Add bot with all permissions (especially Manage Topics, Delete Messages, Pin Messages)

### 4.5 Register and Sync

In the Telegram group:
1. `/register A1B2C3D4` -- register yourself with the token from the server output
2. `/sync` -- enable auto-sync for this group

The bot checks permissions and creates topics for all current windows. From now on, new chat tabs get topics automatically.

### 4.6 Bot Commands

| Command | Description |
|---------|-------------|
| `/register <token>` | Register with the token shown in server output |
| `/sync` | Enable auto-sync (active tabs + last 5 messages) |
| `/sync_all` | Create topics for ALL tabs in all windows |
| `/unsync` | Disable sync, delete tracked topics, clear state |
| `/cleanup` | Delete stale/untracked topics, keep active ones |
| `/purge` | Delete ALL topics (runs in background) |
| `/status` | Sync state, connection, agent info, group ID |
| `/history [N]` | Last N messages (default 30). `/history 100` for more |
| `/mode` | Show/switch mode (Agent/Plan/Ask/Debug) |
| `/model` | Show current model |
| `/plan <text>` | Prompt in Plan mode |
| `/agent <text>` | Prompt in Agent mode |

**Plain text** in any topic is forwarded to the mapped Cursor agent.

### 4.7 How It Works

- **Window Monitor** polls all Cursor windows every 10s using **parallel CDP connections** (no visible window switching)
- New/changed messages are formatted as Telegram HTML and sent to the matching topic
- If HTML fails (unsupported tags), messages are retried as plain text
- A **rate-limited send queue** prevents 429 errors (~300ms between Telegram sends, 100ms between edits; see `send-queue.ts` / transport config)
- **Data files** in `data/` (all gitignored):
  - `license.key` -- license key (required on first run)
  - `telegram-auth.json` -- registration token + registered users with usernames
  - `telegram-sync.json` -- sync state and group ID
  - `telegram-topics.json` -- topic mappings with high water mark
  - `telegram-messages.json` -- tracked message IDs

### 4.8 Authentication

**Option A: Token-based (default)**
Share the registration token (shown in server output) with collaborators. Each person runs `/register <token>` once. Their username and ID are saved to `data/telegram-auth.json`.

**Option B: Hardcoded (override)**
Set `TELEGRAM_ALLOWED_USERS=123456789,987654321` in `.env` (standalone) or `cursorRemote.telegram.allowedUsers` in Settings (extension). When set, this **overrides** the token auth — only these user IDs can use the bot. Remove the setting to go back to token-based auth.

---

## 5. Production (Standalone)

### Option A: tmux

```bash
tmux new -s cursor-remote
npm run dev
# Ctrl+B D to detach
```

### Option B: Compiled

```bash
npm run build
npm start
```

Ensure `data/license.key` exists before running `npm start` (no prompt in production mode).

---

## 6. Troubleshooting

### General

#### "No valid license key" or server exits immediately
- **Extension:** Open the CursorRemote sidebar panel and click "License Key Required" to enter your key
- **Standalone:** Run `npm run dev` (not `npm start`) to get the interactive prompt
- Get a valid key from the [store](https://cursor-remote.com/buy?utm_source=github&utm_medium=setup_guide&utm_campaign=license)

#### "Disconnected" in web UI
- First check `http://<server>:<port>/health` from the phone or tablet
- `connected: false` means the relay is not attached to Cursor/CDP yet
- `connected: true` with `extractorStatus: "waiting"` means the relay is attached to Cursor but is still waiting for the first DOM snapshot
- `connected: true` with `extractorStatus: "stale"` means Cursor/CDP is still connected but DOM extraction is failing or background-throttled
- `lastExtractionError` shows the latest extractor failure reason

#### macOS: Cursor backgrounds and the phone stops updating
- On macOS, Electron/Chromium can throttle a backgrounded Cursor window enough for `Runtime.evaluate` to time out
- If `/health` shows `connected: true` and `extractorStatus: "stale"`, bring Cursor back to the foreground and wait for the next successful snapshot
- The relay now backs off repeated extractor timeouts instead of hammering CDP continuously

#### Phone/tablet can't connect
- `curl http://<ip>:<port>/health` from another device
- Check firewall, port forwarding, WSL2 networking
- Verify the server is bound to `0.0.0.0` or your specific IP (not `127.0.0.1`)

#### Older mobile browser shows a blank or broken UI
- Recent builds no longer require `crypto.randomUUID()` support in the browser
- If the page still fails to load, open the browser console and check for other unsupported Web APIs
- Upgrade to the latest CursorRemote build before testing older iOS/Android browsers

### Extension-Specific

#### Server shows "Disconnected" in the sidebar
- Open the Output panel (**CursorRemote: Show Logs**) and check for errors
- Try Stop > Start from the sidebar buttons
- Verify CDP is enabled: `http://localhost:9222/json` should return JSON

#### Multiple Cursor windows
- Only one server runs. The first window is the owner; others are observers.
- The sidebar shows "observer" next to the server status for non-owner windows.
- If the owner window closes, an observer auto-recovers within ~15 seconds.

#### Telegram bot doesn't respond
- Check the Output panel for connectivity messages
- The server tests outbound HTTPS on startup and reports if Telegram API or all HTTPS is unreachable
- Ensure no other bot instance is running with the same token
- The registration token is shown in the Output panel and the Setup Panel's Telegram tab

### Standalone-Specific

#### Bot doesn't respond
- `TELEGRAM_ENABLED=true` in `.env`?
- Bot is admin with Manage Topics permission?
- Privacy mode OFF? (`@BotFather` > Bot Settings > Group Privacy)
- Did you `/register` with the correct token?
- Check `temp/server.log` for errors

#### /sync says "not a supergroup" or "not a forum"
- Enable Topics in Group Settings first (auto-converts to supergroup)
- The bot auto-detects the correct group ID from `/sync`

#### /sync says "missing permissions"
- Go to Group Settings > Administrators > Bot > enable all listed permissions
- Required: Manage Topics, Delete Messages, Pin Messages

#### Build doesn't work on macOS
- `npm run build` compiles TS and copies `src/client/` to `dist/client/`
- `npm start` creates the `temp/` directory automatically

#### Server log
All output with timestamps: `temp/server.log`
