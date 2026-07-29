# Private voice PWA — deployment and privacy guide

Operator guide for the private read-only voice surface: a one-page installable
web app that places a voice call to your own Hermes context and can only *read*
it.

This document contains **no credentials**. Every secret is referred to by
environment-variable name only.

---

## 1. What this is, and what it is not

**Is:**

- A single-user, private voice companion for one authenticated operator.
- Read-only: it can describe sessions, status and recent conversation, and end
  its own call. Nothing else.
- Browser ⇄ OpenAI Realtime audio over WebRTC, pinned to `gpt-realtime-2.1`.

**Is not** (explicit non-goals):

- No PSTN, SIP, Twilio, phone numbers, or inbound calls.
- No public internet deployment.
- No multi-user tenancy or shared calls.
- No voice approval, rejection, message sending, or command execution.
- No offline calling, background sync, or push notifications.
- No audio recording or transcript archive.
- No alternate, preview, mini or fallback Realtime model.

---

## 2. Data flow and privacy

```
Phone PWA ──HTTPS (Tailscale)──> relay        POST /api/voice/token
   │                               │            mints a short-lived ephemeral credential
   │                               │            + sessionId, epoch, one-time attachToken
   │
   ├──WebRTC audio──────────────> OpenAI Realtime (gpt-realtime-2.1)
   │                               ▲
   └──HTTPS──> relay ──sideband WS─┘   server-held standard key, tool calls only
                  │
                  └─> HermesConversationReader (read-only, bounded, redacted)
```

Be clear with yourself about what this means:

- **Your audio goes to OpenAI.** "Private relay" means the relay is not exposed
  to the internet — it does **not** mean the conversation avoids OpenAI.
- The relay never receives or records audio. Audio is browser ⇄ OpenAI only.
- Bounded, redacted Hermes text context and tool responses **are** sent to
  OpenAI through the Realtime session.
- Nothing persists audio, SDP, provider event bodies, ephemeral credentials or
  transcripts. Only coarse lifecycle metadata and the cost/session ledger are
  written to disk.
- Speech in the call is never written back into Hermes.

---

## 3. Network: Tailscale + HTTPS (required)

Microphone access requires a **secure context**. Plain HTTP over a LAN or a bare
tailnet IP will not grant the microphone on mobile, so `https://` is mandatory
for this surface. (The legacy non-voice web client in
[`tailscale-setup.md`](./tailscale-setup.md) can run over plain HTTP; the voice
page cannot.)

### 3.1 Bind the relay to loopback

```bash
SERVER_HOST=127.0.0.1
SERVER_PORT=3000
```

Do not bind `0.0.0.0`. Do not port-forward. Do not open a firewall rule.

### 3.2 Publish it with Tailscale Serve

```bash
# One-time: enable HTTPS certificates for your tailnet
tailscale cert --help          # confirms MagicDNS + HTTPS are enabled

# Publish loopback:3000 as HTTPS on your tailnet name
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000

# Verify
tailscale serve status
```

Your phone then opens:

```
https://<machine>.<tailnet>.ts.net/voice
```

Use `tailscale serve`, **not** `tailscale funnel` — Funnel publishes to the
public internet, which is an explicit non-goal here.

### 3.3 Install to the home screen

Open `/voice` in Safari (iOS) or Chrome (Android) and use *Add to Home Screen*.
The app is installable and online-only; it caches nothing.

---

## 4. Application authentication

Tailscale is defence in depth, not the only authentication layer.

Set a web app password so the relay requires a login:

```bash
WEBAPP_PASSWORD=<set-a-strong-value>     # value not shown here
```

With it set:

- `/voice`, `/voice.js` and `/voice.css` require an authenticated session and
  redirect to `/login` otherwise.
- Every `/api/voice/*` endpoint requires the session and is rate-limited.
- Requests with a foreign `Origin` are rejected.
- All voice responses are sent `Cache-Control: no-store`.

The manifest, service worker and icons stay public — they contain no secrets and
installability should work before login.

---

## 5. Environment variables

Names only. Never commit values; keep them in your secret store.

### Required

| Variable | Purpose |
| --- | --- |
| `VOICE_ENABLED` | Set `true` to enable the voice transport. |
| `OPENAI_API_KEY` | **Server-only** standard key. Mints ephemeral credentials and opens the sideband. Never sent to the browser, never logged. |
| `WEBAPP_PASSWORD` | Enables relay authentication. Required for a private deployment. |
| `SERVER_HOST` / `SERVER_PORT` | Loopback bind for the relay. |

### Hermes context (read-only)

| Variable | Purpose |
| --- | --- |
| `HERMES_READ_CONTEXT_URL` | Documented read-only Hermes endpoint. Must be HTTPS, or loopback HTTP. **If unset, voice reports context unavailable** — it never invents conversation content. |
| `HERMES_READ_CONTEXT_TOKEN` | Optional server-only bearer for that endpoint. Never returned or logged. |

### Model

There is **no model variable to configure.** Every Realtime session is pinned to
`gpt-realtime-2.1` by `VOICE_REALTIME_MODEL` in
`src/server/transports/voice/constants.ts`.

`VOICE_MODEL` survives only as a tripwire: if it is set to anything other than
`gpt-realtime-2.1`, the server **refuses to start**. There is no mini model, no
preview model, no automatic fallback and no retry against another model.

### Caps and lifecycle

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOICE_NAME` | `marin` | Realtime output voice. |
| `VOICE_USAGE_PRICE_VERSION` | `openai-realtime-2026-01` | Known price-table version. Admission is denied if pricing is unknown. |
| `VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE` | `50` | Conservative local estimate. |
| `VOICE_USAGE_DAILY_CAP_CENTS` | `500` | Hard daily cap per account. |
| `VOICE_USAGE_PER_SESSION_CAP_CENTS` | `100` | Per-session reservation and hard cap. |
| `VOICE_SESSION_ABSOLUTE_MS` | `1800000` | Absolute wall-clock session cap. |
| `VOICE_SESSION_IDLE_MS` | `120000` | Idle termination bound. |
| `VOICE_SESSION_IDLE_GRACE_MS` | `60000` | Grace window before reaping an idle session. |
| `VOICE_SESSION_LEASE_MS` | `30000` | Heartbeat lease length. |

Heartbeats keep the lease alive but deliberately do **not** refresh user
idleness, so an unattended open tab still gets reaped.

---

## 6. Credential handling

**Standard key (`OPENAI_API_KEY`)**

- Server environment or secret manager only.
- Used for minting ephemeral credentials and for the sideband WebSocket.
- Never included in client assets, API responses, logs or error bodies.

**Ephemeral browser credential**

- Returned once to the authenticated browser.
- Memory-only for the duration of WebRTC negotiation, then dropped.
- Never logged, never persisted, never written to `localStorage` /
  `sessionStorage`, never placed in a URL, never cached by the service worker.
- Sent only to OpenAI during WebRTC setup.

**Attach token**

- Short-lived, single-use, bound to the authenticated owner, `sessionId` and
  `epoch`. Consumed before any provider I/O, so a replay cannot attach a second
  sideband.

**Rotation**

Rotate `OPENAI_API_KEY` at your provider, update the environment, restart the
relay. In-flight calls end at their next lease expiry. Rotating
`WEBAPP_PASSWORD` invalidates future logins; existing session cookies are
cleared by restarting with a new data directory if you need a hard reset.

---

## 7. Running

```bash
# Secrets come from your own store; values are never printed.
set -a; source <your-secret-env-file>; set +a

VOICE_ENABLED=true \
SERVER_HOST=127.0.0.1 \
npm run build && npm start
```

Then from the phone, on the tailnet:

```
https://<machine>.<tailnet>.ts.net/voice
```

Tap **Call**, grant the microphone, and speak. Tap **Hang up** to end.

### Health

`GET /api/voice/status` (authenticated) reports connection, session id, epoch,
state, idle status, context availability, component health, and budget. It never
returns a credential.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Button does nothing; state stays `Ready` | Page not served over HTTPS | Use `tailscale serve` and open the `https://…ts.net` URL, not an IP. |
| `Microphone permission is required` | Permission denied, or insecure context | Grant the mic in site settings; confirm the padlock. |
| Redirected to `/login` | No authenticated session | Log in with `WEBAPP_PASSWORD`. |
| `Could not start a call right now.` | Token mint failed | Check `OPENAI_API_KEY` is set server-side and the provider is reachable. |
| Voice says live context is unavailable | `HERMES_READ_CONTEXT_URL` unset or unreachable | Configure the documented read endpoint. This is intentional — it will never invent content. |
| Server refuses to start, complains about `VOICE_MODEL` | `VOICE_MODEL` set to a non-pinned model | Unset it, or set it to exactly `gpt-realtime-2.1`. |
| Call ends by itself | Budget cap, idle timeout, or absolute session cap | Check `/api/voice/status` budget fields and the caps above. |
| `The call dropped and could not be restored.` | Two transport failures in one call | Tap **Call again**. Reconnect is deliberately bounded to one attempt per call. |

---

## 9. Verification

Automated gates (no OpenAI call is made by any of them):

```bash
npx tsc --noEmit                                  # strict typecheck (src)
npx tsc -p tsconfig.test.json --noEmit            # strict typecheck (src + tests)
npm test                                          # full suite, zero skips
npm run build                                     # production build
npx tsx --test tests/private-voice-smoke.test.ts  # mocked provider lifecycle
```

Proving real microphone and WebRTC interoperability requires a separate,
explicitly authorised operator smoke against OpenAI. Until that is run, describe
the state as **automated and mock verified**, not "live verified".
