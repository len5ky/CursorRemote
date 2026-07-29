# Private voice — read-only voice companion for Hermes

> Formerly "DICKTATOR / car mode". The mutation-capable voice surface described
> by earlier revisions of this file **no longer exists**. See
> [§ What changed](#what-changed) below.

The private voice surface is a single-user, installable web app that places a
voice call to your own Hermes context over OpenAI Realtime. It can **read** that
context and end its own call. It cannot change anything.

Deployment, Tailscale/HTTPS, environment variables and privacy:
**[`private-voice-pwa-deploy.md`](./private-voice-pwa-deploy.md)**.

## Architecture

```
Phone PWA (/voice)                    Relay server                        OpenAI
┌─────────────────┐  POST /api/voice/token   ┌────────────────────┐
│  Call / Hang up │ ───────────────────────► │ RealtimeBridge      │ ──► POST /v1/realtime/client_secrets
│                 │ ◄─ ephemeral credential ─│  (standard key      │      (server-side only)
│                 │    sessionId, epoch,     │   never leaves here)│
│                 │    one-time attachToken  │                     │
│                 │                          │                     │
│  WebRTC (audio) │ ═══════════════════════════════════════════════► /v1/realtime/calls
│                 │  POST /api/voice/call    │                     │
│                 │ ──── {callId, …} ──────► │ sideband WS ═══════════► wss://…/v1/realtime?call_id=…
└─────────────────┘                          └─────────┬───────────┘
                                                       │ read-only tool calls
                                             ┌─────────▼────────────────┐
                                             │ VoiceToolRouter          │
                                             │ HermesConversationReader │  (read-only, bounded, redacted)
                                             └──────────────────────────┘
```

Key points:

- **Audio never touches the relay.** The browser connects WebRTC directly to
  OpenAI using an ephemeral client secret minted server-side. The relay attaches
  a **sideband WebSocket** with its own standard key and handles tool calls
  there.
- **Exact model.** Every Realtime session is pinned to `gpt-realtime-2.1` by a
  single constant. There is no mini model, preview model, or fallback, and no
  environment variable that can select one.
- **Read-only by construction.** The tool set is
  `list_sessions, get_status, get_all_status, read_recent, disconnect_voice`.
  `disconnect_voice` is transport control — it ends the voice call and never
  touches Hermes. Legacy mutation names and unknown names fail closed with a
  stable `read_only_denied` result that does not drop the sideband.
- **No mutator to reach.** `VoiceToolDeps` carries only a
  `HermesConversationReader` and the transport disconnect. The voice subsystem
  has no `CommandExecutor` dependency at all, so a prompt injection or dispatch
  bug has nothing to call.
- **Honest context.** Production wires `HttpHermesConversationReader` against a
  documented read-only endpoint. When that endpoint is unconfigured or
  unreachable it returns `unavailable` and the assistant says so. It never
  substitutes canned text, and production cannot select a test fixture.
- **Session safety.** The server owns `idle → admitting → active → terminating
  → terminated|failed`. Sideband events and tool calls are accepted only for the
  current session id and epoch; hangup is idempotent; a delayed event from an
  earlier call cannot affect a later one.
- **One-time attach grant.** The attach token is single-use and bound to owner,
  session and epoch, and is consumed before any provider I/O.
- **Budget and idle.** Admission reserves against an account-keyed daily ledger
  using versioned known pricing. Unknown pricing, cap/idle/lease expiry, and the
  absolute session cap deny or terminate safely.

Source: `src/server/transports/voice/`
(`constants.ts`, `context.ts`, `tools.ts`, `realtime-bridge.ts`, `session.ts`,
`index.ts`), the PWA in `src/client/` (`voice.html`, `voice.css`, `voice.js`,
`manifest.webmanifest`, `voice-sw.js`), and relay endpoints
`/api/voice/{token,call,terminate,disconnect,heartbeat,status}`.

## The phone surface

One screen: a title, a compact state line, one large Call / Hang up button, and
one status line. No approval controls, no text entry, no model selection, no
settings, no transcript, no debug output.

States surfaced: Ready, Microphone requested, Connecting, Listening, Speaking,
Reconnecting, Ending, Ended, Error.

Behaviour worth knowing:

- The microphone is requested from the user gesture, before any credential is
  minted; every failure path stops all local tracks.
- The call is only "live" once WebRTC **and** sideband registration succeed.
- Reconnect is bounded to **one** attempt per call, always with a fresh
  credential and a new epoch. The budget is per call, not per connection, so a
  flapping link cannot reconnect indefinitely.
- Explicit Hang up never reconnects, and neither does a server-side hangup.
- `pagehide` performs best-effort cleanup via `sendBeacon`; correctness never
  depends on that request arriving, because the server lease reaper is
  authoritative.
- The service worker is network-only and caches nothing.

## Configuration

All environment variables, caps and secret-handling rules live in
[`private-voice-pwa-deploy.md § 5`](./private-voice-pwa-deploy.md#5-environment-variables).

The short version: `VOICE_ENABLED`, `OPENAI_API_KEY` (server-only),
`WEBAPP_PASSWORD`, `VOICE_PUBLIC_ORIGIN`, `HERMES_READ_CONTEXT_URL` (+ optional
`HERMES_READ_CONTEXT_TOKEN`), `VOICE_NAME`, `VOICE_ACCOUNT_ID`, and the
`VOICE_USAGE_*` / `VOICE_SESSION_*` caps. Names only — values live in your
secret store, never in the repo.

Four of those are hard startup gates:

- **`WEBAPP_PASSWORD` is mandatory** with `VOICE_ENABLED=true`. Without it the
  server refuses to start, and a relay in that state answers `503` on every
  voice route rather than serving an unauthenticated voice surface.
- **`VOICE_PUBLIC_ORIGIN`** is the canonical browser origin
  (`https://<machine>.<tailnet>.ts.net`), validated at startup and never
  inferred from `Host` or any `X-Forwarded-*` header. Unset means loopback
  origins only, so every phone request is refused with `403 Origin denied`.
- There is **no model variable**. Every session is pinned to `gpt-realtime-2.1`
  — no mini, no preview, no fallback — and setting `VOICE_MODEL` to anything
  else fails startup.
- **`VOICE_USAGE_PRICE_VERSION`** must name a version in the frozen price table
  (`src/server/transports/voice/pricing.ts`). An invented version fails startup
  and is refused again at admission, so a paid call is never metered against a
  rate card nobody reviewed. Every numeric `VOICE_*` value is range-validated
  at startup for the same reason.

## Deployment

Private tailnet only, over HTTPS, with the relay bound to loopback:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status          # https://<machine>.<tailnet>.ts.net → http://127.0.0.1:3000
tailscale funnel status         # must report no Funnel: public exposure is a non-goal
```

Full procedure, including the `VOICE_PUBLIC_ORIGIN` value this implies:
[`private-voice-pwa-deploy.md § 3`](./private-voice-pwa-deploy.md#3-network-tailscale--https-required).

## Smoke test

```bash
set -a; source <your-secret-env-file>; set +a    # OPENAI_API_KEY, WEBAPP_PASSWORD
VOICE_ENABLED=true SERVER_HOST=127.0.0.1 \
  VOICE_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net npm run dev
```

Open `https://<machine>.<tailnet>.ts.net/voice` from the phone — a browser, on
the tailnet; the browser PWA is the only supported client — log in, tap
**Call**, and try:

1. *"list my sessions"* → speaks back the connected Hermes contexts.
2. *"what's the status?"* → speaks the current agent status.
3. *"what happened recently?"* → summarises bounded recent context.
4. *"approve that"* → must refuse and say the surface is read-only.

Automated tests. Every provider interaction is a double — an injected `fetch`
and a fake sideband socket — so none of these reach `api.openai.com`:

```bash
npm test                                       # full suite, zero skips
npx tsx --test tests/voice-*.test.ts tests/private-voice-*.test.ts   # voice only
```

## Disconnect, health, and recovery

**Hang up** tears down microphone, audio, timers, data channel and peer
connection, then makes a bounded `POST /api/voice/terminate` carrying session and
epoch. The server revokes tool authority, closes the sideband, asks OpenAI to
hang up, and emits `voice:hangup`. An unconfirmed provider hangup is retried by
an orphan reaper and is reported honestly as unconfirmed, never as verified
teardown.

`/api/voice/status` reports connection, session id, epoch, state, idle status,
context availability, component health (voice, sideband, relay socket, context)
and budget. It never returns a credential.

<a id="what-changed"></a>
## What changed

Earlier revisions of this document described a mutation-capable voice surface.
That surface has been **removed**, not merely hidden. Specifically:

| Removed | Why |
| --- | --- |
| `set_target`, `send_to_session`, `approve`, `reject`, `run_action`, `skip_action`, `set_mode`, `set_model`, `cancel` | Voice is read-only. These now fail closed. |
| `confirm_pending` / staged confirmation tokens, `/api/voice/confirm`, `/api/voice/defer` | There is no staged mutation to confirm. |
| `CommandExecutor` dependency in the voice composition | A read-only prompt is not a security boundary; the code graph now makes mutation impossible. |
| `digest.ts`, `OPENROUTER_API_KEY`, `VOICE_DIGEST_MODEL`, `VOICE_TTS_MODEL`, `VOICE_STT_MODEL` | The second-provider digest path sent conversation content to OpenRouter. `gpt-realtime-2.1` now summarises the supplied read-only material directly, removing a whole context-sharing surface. |
| `VOICE_MODEL` as a selectable model, `gpt-realtime-2.1-mini` as a fallback | The model is pinned to one constant. `VOICE_MODEL` is now only a startup tripwire. |
| `VOICE_PROACTIVE_MIN_INTERVAL_MS` and proactive announcements | Not part of the private read-only surface. |

**Android client status: unsupported.** The native Android phone/Auto client in
`apps/dicktator-android` was built against the old, mutation-capable contract —
its Android Auto **Approve** / **Later** controls call `/api/voice/confirm` and
`/api/voice/defer`, which no longer exist. It is **not supported** on V1: it is
not built, tested, or shipped, and its sources are archived for reference only.
The supported V1 voice surface is the browser PWA at `/voice`, which is
installable and runs in an Android browser as well as anywhere else. Any native
Android compatibility work — porting the client to the read-only contract, or
removing it — is future work, not a claim this document makes about today.

Historical design records are preserved in
[`dicktator-v1-contracts.md`](./dicktator-v1-contracts.md) and
[`dicktator-final-build.plan.md`](./dicktator-final-build.plan.md); both are
superseded by this document.
