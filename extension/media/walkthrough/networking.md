## Network Access

By default, the server binds to `127.0.0.1` (localhost only). To control Cursor from your phone you have two options:

### Option 1 — Same LAN
Set the bind address to `0.0.0.0` so devices on your local network can connect. A strong password is auto-generated to protect the web client.

### Option 2 — Tailscale (recommended)
Install [Tailscale](https://tailscale.com/) on both your computer and phone. Your server will be accessible over a secure WireGuard mesh — no port forwarding or firewall changes needed.

Open the **Setup Panel** for a guided walkthrough of either option.
