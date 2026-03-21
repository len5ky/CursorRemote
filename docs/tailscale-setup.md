# Secure Access with Tailscale

> **Extension users:** Open the Setup Panel (`CursorRemote: Open Setup Panel`) and select **Specific address (Tailscale / custom)** under Networking. Enter your Tailscale IP, click **Save & Restart**, and you're done. The instructions below cover the full manual setup.

Tailscale creates a private mesh VPN between your devices. Instead of exposing port 3000 to your LAN (or the internet), you access the web app over a Tailscale IP that only your devices can reach. No port forwarding, firewall rules, or DNS configuration required.

## Why Tailscale

- **Zero exposure** -- the relay server is never reachable from the public internet
- **Works across networks** -- access from phone on cellular, laptop at a coffee shop, etc.
- **No port forwarding** -- especially useful for WSL2 where LAN exposure is painful
- **End-to-end encrypted** -- WireGuard under the hood
- **Free tier** -- up to 100 devices on the personal plan

## 1. Install Tailscale on the Server

Install on the machine (or WSL2 instance) where the relay server runs.

### Linux / WSL2

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Follow the auth URL printed in the terminal to log in.

### macOS

```bash
brew install tailscale
sudo tailscale up
```

### Windows 11

```bash
winget install tailscale
tailscale up
```

OR

Download from [tailscale.com/download](https://tailscale.com/download) and sign in.

Or install the App Store version.

### Verify

```bash
tailscale ip -4
# prints something like 100.64.1.23
```

## 2. Install Tailscale on Your Phone

- **iOS**: [App Store](https://apps.apple.com/app/tailscale/id1470499037)
- **Android**: [Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn)

Sign in with the same account. Both devices should appear in your Tailscale admin console.

## 3. Access the Web App

Open `http://<tailscale-ip>:3000` on your phone, where `<tailscale-ip>` is the server's Tailscale IP from step 1 (e.g. `http://100.64.1.23:3000`).

If you have Tailscale MagicDNS enabled, you can use the machine name instead:

```
http://my-desktop:3000
```

## 4. Lock Down to Tailscale Only

By default the server binds to `127.0.0.1` (localhost). To restrict it to Tailscale only:

- **Extension:** Open Setup Panel > Networking > select "Specific address (Tailscale / custom)" > enter your Tailscale IP > Save & Restart. Or set `cursorRemote.serverHost` directly in Settings.
- **Standalone:** Set `SERVER_HOST` in `.env`:

```bash
# .env
SERVER_HOST=100.64.1.23   # your Tailscale IP
```

Now the server only listens on the Tailscale interface. Local network and internet connections are rejected at the OS level.

## 5. Tailscale + Password (Defense in Depth)

For extra security, combine Tailscale with the webapp password:

- **Extension:** The password is auto-generated on first install. You can view or change it in the Setup Panel or in Settings (`cursorRemote.webappPassword`).
- **Standalone:** Set both in `.env`:

```bash
# .env
SERVER_HOST=100.64.1.23
WEBAPP_PASSWORD=my-secret-password
```

This way, even if someone joins your Tailscale network, they still need the password.

## 6. Tailscale Funnel (Temporary Public Access)

If you need to share access temporarily without requiring Tailscale on the other device:

```bash
tailscale funnel 3000
```

This creates a public HTTPS URL (e.g. `https://my-desktop.tail1234.ts.net:443`). Stop it with Ctrl+C when done. Combine with `WEBAPP_PASSWORD` to prevent unauthorized access through the funnel.

## Troubleshooting

### "Connection refused" on phone
- Both devices signed into the same Tailscale account?
- `tailscale status` shows both devices as connected?
- Server running with the correct `SERVER_HOST`?

### WSL2-specific
- Install Tailscale inside WSL2, not on the Windows host (unless using mirrored networking)
- If using mirrored networking, you can install Tailscale on Windows and it works for WSL2 too

### MagicDNS not resolving
- Enable MagicDNS in your Tailscale admin console (DNS settings)
- On some phones you may need to restart the Tailscale app after enabling
