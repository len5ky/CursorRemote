# Private voice — read-only voice companion for Hermes

> Formerly "DICKTATOR / car mode". The mutation-capable voice surface described
> by earlier revisions of this file **no longer exists**. See
> [§ What changed](#what-changed) below.

The private voice surface is a single-user, installable web app that places a
voice call to your own **private Hermes deployment** over OpenAI Realtime.

The Realtime model is **ears and mouth only**: it transcribes what you say and
reads back what Hermes answered. It has no tools, no knowledge of its own, and
never answers anything itself. Every word of substance comes from Hermes, over
one server-to-server route the browser never sees.

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
                                                       │ final transcript in,
                                                       │ audio rendering out
                                             ┌─────────▼─────────────────┐
                                             │ HermesSessionChatClient   │
                                             │ POST {VOICE_HERMES_API_URL}
                                             │   /api/sessions/{id}/chat │
                                             │ server-only credentials   │
                                             └───────────────────────────┘
```

Key points:

- **Audio never touches the relay.** The browser connects WebRTC directly to
  OpenAI using an ephemeral client secret minted server-side. The relay attaches
  a **sideband WebSocket** with its own standard key and owns every turn there.
- **Hermes is the only conversational authority.** On the final input
  transcript (`conversation.item.input_audio_transcription.completed` — never an
  audio commit, never speech-start) the relay sends that exact text to the
  private Hermes deployment, server-to-server, and injects the answer back as an
  out-of-band audio-only `response.create` (`conversation: 'none'`) whose sole
  input is that text. The generated audio is a rendering, not an answer.
- **Exact model.** Every Realtime session is pinned to `gpt-realtime-2.1` by a
  single constant. There is no mini model, preview model, or fallback, and no
  environment variable that can select one.
- **No provider tool surface at all.** The session declares `tools: []` and
  `tool_choice: 'none'`, and server VAD runs with `create_response: false` and
  `interrupt_response: false`. There is no dispatch path to allow or deny: a
  function call the session never offered is refused outright and ends the
  session. Hangup stays an authenticated HTTP route, never a Realtime tool.
- **Tool-free by deployment, not by prompt.** Hermes session chat has no
  per-request tool disable, so V1 requires a dedicated Hermes API server with
  MCP disabled and `api_server.toolsets` reported as exactly `[]`. The relay
  checks that deployment's capabilities report and refuses to place a call if it
  does not certify — including for a toolset merely *named* read-only, which is
  a label it cannot verify. A system prompt is never treated as enforcement.
- **No mutator to reach.** The voice subsystem has no `CommandExecutor`
  dependency and no tool router at all, so a prompt injection or dispatch bug
  has nothing to call.
- **Honest silence.** When Hermes cannot answer — unreachable, an error status,
  an unparseable body, content over the byte bound — nothing is spoken. There is
  no fallback answer, no canned line, and production cannot select a fixture.
- **Turn semantics are server-owned.** Turn ids are monotonic. The operator
  starting to speak aborts the outstanding Hermes fetch and cancels any Hermes
  rendering being spoken, by response id, so a late answer to an abandoned
  question is never voiced. Aborting the relay's fetch cannot cancel a run
  Hermes has already started upstream — the relay stops listening, it cannot
  un-ask the question.
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
(`constants.ts`, `hermes-chat.ts`, `realtime-bridge.ts`, `session.ts`,
`text.ts`, `index.ts`), the PWA in `src/client/` (`voice.html`, `voice.css`, `voice.js`,
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
`WEBAPP_PASSWORD`, `VOICE_PUBLIC_ORIGIN`, the four required server-only Hermes
route values (`VOICE_HERMES_API_URL`, `VOICE_HERMES_API_KEY`,
`VOICE_HERMES_SESSION_ID`, `VOICE_HERMES_SESSION_KEY`), `VOICE_NAME`,
`VOICE_ACCOUNT_ID`, and the `VOICE_USAGE_*` / `VOICE_SESSION_*` caps. Names
only — values live in your secret store, never in the repo.

The Hermes session identity is server state. The browser cannot choose it,
supply it, or read it back, and it never appears in a client asset or in any
response body.

These are hard startup gates:

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

1. *"where are we up to?"* → the transcript goes to Hermes, and Hermes' answer
   is read back to you verbatim.
2. *"approve that"* → whatever Hermes replies is read back. It cannot act: the
   deployment behind voice has no toolsets at all and MCP is off, which is a
   deployment fact the relay verifies, not a promise in a prompt.
3. Start talking while it is speaking → the answer stops, the outstanding
   Hermes fetch is abandoned, and its result is never spoken.

Automated tests. Every provider interaction is a double — an injected `fetch`
and a fake sideband socket — so none of these reach `api.openai.com`:

```bash
npm test                                       # full suite, zero skips
npx tsx --test tests/voice-*.test.ts tests/private-voice-*.test.ts   # voice only
```

## Disconnect, health, and recovery

**Hang up** tears down microphone, audio, timers, data channel and peer
connection, then makes a bounded `POST /api/voice/terminate` carrying session and
epoch. The server ends the session, closes the sideband, asks OpenAI to
hang up, and emits `voice:hangup`. An unconfirmed provider hangup is retried by
an orphan reaper and is reported honestly as unconfirmed, never as verified
teardown.

`/api/voice/status` reports connection, session id, epoch, state, idle status,
`hermesCertified` (whether a currently certified private Hermes deployment is
behind this surface — the same fact admission gates on), component health
(voice, sideband, relay socket, hermes) and budget. It never returns a
credential, and never the Hermes session id or key.

A call refused because the deployment has not certified answers **503 Voice is
unavailable** — a deliberate refusal on an unmet precondition, not a 500. Which
precondition failed is in the server log only.

<a id="what-changed"></a>
## What changed

Earlier revisions of this document described a mutation-capable voice surface.
That surface has been **removed**, not merely hidden. Specifically:

| Removed | Why |
| --- | --- |
| `set_target`, `send_to_session`, `approve`, `reject`, `run_action`, `skip_action`, `set_mode`, `set_model`, `cancel` | Voice is read-only. There is no tool dispatch left to reach. |
| The read-only tool set (`list_sessions`, `get_status`, `get_all_status`, `read_recent`, `disconnect_voice`), `VoiceToolRouter`, and `HermesConversationReader` | They made the *provider* the assistant, with Hermes demoted to a data source it could quote or ignore. Hermes is now the only conversational authority, reached server-to-server, and the provider has no tools at all. |
| `confirm_pending` / staged confirmation tokens, `/api/voice/confirm`, `/api/voice/defer` | There is no staged mutation to confirm. |
| `CommandExecutor` dependency in the voice composition | A read-only prompt is not a security boundary; the code graph now makes mutation impossible. |
| `digest.ts`, `OPENROUTER_API_KEY`, `VOICE_DIGEST_MODEL`, `VOICE_TTS_MODEL`, `VOICE_STT_MODEL` | The second-provider digest path sent conversation content to OpenRouter. Removing it removed a whole context-sharing surface. |
| `HERMES_READ_CONTEXT_URL` / `HERMES_READ_CONTEXT_TOKEN` | Replaced by the four `VOICE_HERMES_*` values: voice no longer *reads* a context snapshot, it *asks* the private deployment and speaks its answer. |
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
