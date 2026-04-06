# Telegram Connection Troubleshooting

If your Telegram bot fails to connect or hangs during startup, work through the sections below in order.

---

## 1. Check the Logs

After starting CursorRemote, look for these log lines:

| Log line | Meaning |
|---|---|
| `[telegram] API reachable — bot: @yourbot` | Telegram API is accessible and the token is valid |
| `[telegram] Bot connected (sync: on/off)` | Bot is fully running — everything is working |
| `[telegram] bot.init() failed: timed out after 15s` | Grammy's HTTP layer timed out calling `getMe` |
| `[telegram] 409 Conflict — another bot instance…` | Two processes are using the same bot token |
| `[telegram] Invalid bot token (401 Unauthorized)` | The token from BotFather is wrong or revoked |

If the log stops **after** `"API reachable"` but **before** `"Bot connected"`, the issue is in the bot framework's startup. See section 3.

---

## 2. Common Problems

### Bot token is invalid
- Open [@BotFather](https://t.me/BotFather) in Telegram.
- Send `/mybots` → select your bot → **API Token** to see the current token.
- If you revoked and regenerated the token, update it in VS Code Settings → `cursorRemote.telegram.botToken` or via the Setup Panel.

### Another instance is polling
Telegram only allows **one** long-polling connection per bot token. If you see `409 Conflict`:
- Stop any other CursorRemote servers using the same token.
- If you recently restarted and the old process didn't shut down cleanly, wait 30–60 seconds for Telegram to release the session, then retry.
- On macOS: check Activity Monitor for orphaned `node` processes.
- On Linux/WSL: `ps aux | grep cursor-remote` or `lsof -i :3000`.

### Network / firewall
If `getMe` fails repeatedly with timeouts:
- Confirm outbound HTTPS works: `curl https://api.telegram.org/bot<TOKEN>/getMe`
- Corporate proxies and VPNs sometimes block Telegram's API domain. Try from a different network.
- WSL2 users: the WSL virtual network uses NAT. Outbound HTTPS normally works but some corporate firewalls filter WSL traffic differently.

### Rate limiting
If the bot was started and stopped many times in quick succession, Telegram may rate-limit the token. Wait 1–2 minutes before retrying.

---

## 3. Grammy Hangs on Startup

**Symptom:** The log shows `"Initializing bot (getMe via Grammy)…"` and then either times out after 15 seconds or hangs indefinitely.

**Cause:** Grammy's internal HTTP client can get stuck on some systems (observed on macOS). The default CursorRemote build wraps Grammy's `fetch` with a 30-second timeout, so it should eventually time out rather than hang forever. But if it keeps timing out:

### Switch to the Raw transport

The **Raw** transport bypasses Grammy entirely and talks to the Telegram Bot API using Node.js's built-in `fetch`. It has identical functionality but avoids Grammy's HTTP stack.

**Option A — Setup Panel:**
1. Open the CursorRemote Setup Panel (`Cmd/Ctrl+Shift+P` → "CursorRemote: Open Setup").
2. Go to the **Telegram** tab.
3. Scroll down to **Transport Engine**.
4. Select **Raw (lightweight fallback)** and click **Save & Restart**.

**Option B — VS Code Settings:**
1. Open Settings (`Cmd/Ctrl+,`).
2. Search for `cursorRemote.telegram.impl`.
3. Change the value to `raw`.
4. Restart the server (CursorRemote: Restart Server).

**Option C — Environment variable:**
Add to your `.env` file:
```
TELEGRAM_IMPL=raw
```

After switching, the log should show:
```
[telegram] Using raw Bot API transport (no Grammy)
[telegram-raw] Bot: @yourbot (id 123456789)
[telegram-raw] Bot connected (sync: on)
```

---

## 4. Bot Connects but Doesn't Respond to Commands

- Make sure you are **registered**. Send `/register <token>` in the Telegram group first.
- The bot ignores messages from unregistered users (no error, no reply — this is by design for security).
- Check that the bot is an **administrator** in the group with **Manage Topics** permission.
- If using a supergroup with Topics enabled, the bot needs the admin permission to post in topics.

---

## 5. Topics Not Created After `/sync`

- The group must have **Topics enabled** (Group Settings → Topics).
- The bot must be an **admin** with **Manage Topics** permission.
- After `/sync`, wait a few seconds. Topic creation uses a delay to avoid rate limits.
- If topics still don't appear, try `/purge` to clear stale state, then `/sync` again.

---

## 6. Still Stuck?

1. Set `TELEGRAM_IMPL=raw` to rule out Grammy issues.
2. Check the full server output for any `[ERROR]` lines.
3. Try with a fresh bot token from BotFather.
4. Open an issue at [github.com/len5ky/CursorRemote](https://github.com/len5ky/CursorRemote/issues) with the relevant log output.
