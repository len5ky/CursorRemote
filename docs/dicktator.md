# DICKTATOR — voice control for Cursor agent sessions

> **You dictate; they obey.**

DICKTATOR is CursorRemote's voice transport ("car mode"): a hands-free layer for
monitoring and driving live Cursor agent sessions by voice. It mirrors the
Telegram transport's command vocabulary over an OpenAI Realtime speech-to-speech
session; voice-session safety is independently enforced by the relay.

## Architecture

```
Browser (web client)                Relay server                       OpenAI
┌─────────────────┐   POST /api/voice/token   ┌──────────────────┐
│ mic button /    │ ────────────────────────► │ RealtimeBridge    │ ──► POST /v1/realtime/client_secrets
│ DICKTATOR panel │ ◄──────ephemeral token────│  (real API key    │
│                 │                           │   server-side)    │
│  WebRTC (audio) │ ═══════════════════════════════════════════════► /v1/realtime/calls
│                 │   POST /api/voice/call    │                   │
│                 │ ────────{callId}────────► │ sideband WS ══════════► wss://…/v1/realtime?call_id=…
└─────────────────┘                           └──────────────────┘
                                                    │ tool calls only
                                              ┌─────▼──────────────┐
                                               │ VoiceTransport      │→ CommandExecutor / StateManager
                                               │ (FSM, budget, closed│  (CDP into live Cursor windows)
                                               │  tools, confirms)   │
                                              └────────────────────┘
```

Key points:

- **Audio never touches the relay.** The browser connects WebRTC directly to
  OpenAI using an ephemeral client secret minted server-side
  (`/v1/realtime/client_secrets`). The relay attaches a **sideband WebSocket**
  (`wss://api.openai.com/v1/realtime?call_id=…`) that owns all tool-call
  handling and proactive announcements.
- **Closed tool set.** The Realtime model can only call:
  `list_sessions, set_target, get_status, get_all_status, read_recent,
  send_to_session, approve, reject, run_action, skip_action, set_mode,
  set_model, cancel, confirm_pending, disconnect_voice`. No shell or arbitrary
  commands. `disconnect_voice` is transport control, never Cursor `cancel`.
- **Server-enforced confirmation.** Mutations return a single-use 90-second token
  bound to session/epoch/lease, target revision, canonical arguments, and tool.
  The relay consumes and revalidates it before execution; termination or target
  change invalidates it.
- **Sticky target.** `set_target` resolves a title once, then pins the stable
  Cursor window/composer identity and revision. Mutations fail closed when that
  exact target is unavailable or stale.
- **Session safety.** The server owns `idle → admitting → active → terminating
  → terminated|failed`; stale session/epoch/lease events are ignored and
  termination revokes authority before bounded provider cleanup.
- **Budget and idle.** Admission reserves against an account-keyed daily ledger
  using versioned known pricing. Unknown pricing, cap/idle/lease expiry, and the
  absolute session cap deny or terminate safely.
- **Spoken digests.** `digest.ts` converts transcript/state into 2–3 spoken
  sentences via a cheap OpenRouter model, stripping file paths, hashes, URLs,
  and code identifiers.
- **Proactive events.** New pending approvals, agent errors, and
  agent-finished transitions are pushed into the Realtime conversation as
  system items (rate-limited, default 15 s minimum gap) so DICKTATOR speaks up
  unprompted.

Source: `src/server/transports/voice/` (`realtime-bridge.ts`, `tools.ts`,
`digest.ts`, `index.ts`) plus `src/client/voice.js` and relay endpoints
`/api/voice/{token,call,terminate,disconnect,heartbeat,status,confirm,defer}`.

## Android V2 + Android Auto

`apps/dicktator-android` mirrors the browser admission path with native WebRTC:
it requests `RECORD_AUDIO`, mints `/api/voice/token`, sends SDP directly to
`https://api.openai.com/v1/realtime/calls`, applies the answer, attaches the
returned call ID via `/api/voice/call`, and heartbeats every 10 seconds. Its
microphone/media-playback foreground service owns the tracks and peer connection.
Both the notification and app Hang Up controls stop local media first and then
call `/api/voice/terminate`. The Android UI displays the sticky target, state,
idle and budget fields returned by `/api/voice/status`.

Android Auto is provided by `DicktatorCarAppService` (Car App Library templates):
**Talk** starts the same WebRTC service; **Approve** / **Later** hit
`/api/voice/confirm` and `/api/voice/defer` for the latest staged confirmation
(token never returned over status); **Hang Up** matches the phone terminate path.
See `apps/dicktator-android/README.md` for DHU / device run steps.

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `VOICE_ENABLED` | `false` | Enable the transport. |
| `OPENAI_API_KEY` | — | Required. Used server-side only; never logged. |
| `VOICE_MODEL` | `gpt-realtime-2.1` | Fallback option: `gpt-realtime-2.1-mini`. |
| `VOICE_NAME` | `marin` | Realtime output voice. |
| `OPENROUTER_API_KEY` | — | For the digest summarizer (falls back to deterministic digests without it). |
| `VOICE_DIGEST_MODEL` | `google/gemini-2.5-flash-lite` | Flash-class digest model. |
| `VOICE_TTS_MODEL` | `x-ai/grok-voice-tts-1.0` | **Config-only — synthesis not wired yet.** Recommended (Jul 2026): Grok Voice TTS, $15/M chars, inline speech tags for pause/emphasis/speed. Fallback: `qwen/qwen-audio-3.0-tts-flash`. |
| `VOICE_STT_MODEL` | `x-ai/grok-stt-1.0` | **Config-only — not wired yet.** For future batch audio ingestion; $0.10/hour. |
| `VOICE_PROACTIVE_MIN_INTERVAL_MS` | `15000` | Rate limit for proactive spoken notifications. |
| `VOICE_USAGE_PRICE_VERSION` | `openai-realtime-2026-01` | Required known price-table version for admission. |
| `VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE` | `50` | Conservative ledger estimate. |
| `VOICE_USAGE_DAILY_CAP_CENTS` | `500` | Account daily hard cap. |
| `VOICE_USAGE_PER_SESSION_CAP_CENTS` | `100` | Session reservation and hard cap. |
| `VOICE_SESSION_ABSOLUTE_MS` | `1800000` | Absolute wall-clock cap. |
| `VOICE_SESSION_IDLE_MS` | `120000` | Idle termination bound. |

Honest status: live speech in/out currently goes entirely through the OpenAI
Realtime session. The OpenRouter TTS/STT models above are reserved config for
a future pipeline (e.g. synthesizing digests server-side, or ingesting
recorded voice memos) and are not called anywhere yet.

## Setup / smoke test

```bash
cd ~/Projects/cursor-ide-remote && git checkout voice-transport
set -a; source ~/.config/palermo/credentials.env; set +a   # OPENAI_API_KEY, OPENROUTER_API_KEY
VOICE_ENABLED=true npm run dev        # Cursor must be running with --remote-debugging-port=9222
```

1. Open `http://127.0.0.1:3000`, tap the mic icon (top right) to reveal the
   DICKTATOR panel, hit **Connect**, grant microphone access.
2. Say: *"list my sessions"* → should speak back window/tab names.
3. Say: *"target <project>"* then *"what's the status?"*.
4. Try a mutation: *"send 'run the tests' to it"* → DICKTATOR must read the
   message back and only execute after your explicit "yes"
   (`confirm_pending` is enforced server-side; a wrong or reused token fails).

Tests: `npx tsx --test tests/voice-session.test.ts tests/voice-tools.test.ts tests/voice-digest.test.ts`.

## Disconnect, health, and recovery

**Hang Up** immediately tears down microphone, audio, timers, and peer connection,
then makes a bounded `POST /api/voice/terminate` request carrying the session and
epoch. The server revokes tools and confirmations, closes the sideband, asks OpenAI
to hang up, and emits `voice:hangup`. A timeout is shown as local disconnect complete
with server cleanup unconfirmed, never verified teardown.

`/api/voice/status` reports separate voice, sideband, relay socket, CDP, and selected
target health plus estimated versus provider-reported spend and remaining budget.
Read-only status may be degraded; mutations require healthy signals and the exact
pinned target revision.

V1 has no automatic model routing, model-switch reconnect, Android/Auto client, or
capability packs. `gpt-realtime-2.1` remains the default; Mini is configuration-only
until a separate adversarial tool-safety evaluation passes.
