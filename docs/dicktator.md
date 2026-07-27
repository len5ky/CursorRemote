# DICKTATOR — voice control for Cursor agent sessions

> **You dictate; they obey.**

DICKTATOR is CursorRemote's voice transport ("car mode"): a hands-free layer for
monitoring and driving live Cursor agent sessions by voice. It mirrors the
Telegram transport's command vocabulary and safety semantics, delivered over an
OpenAI Realtime speech-to-speech session.

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
                                              │ VoiceToolRouter     │→ CommandExecutor / StateManager
                                              │ (closed tool set +  │  (CDP into live Cursor windows)
                                              │  confirm tokens)    │
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
  set_model, cancel, confirm_pending`. No shell, no arbitrary commands.
- **Server-enforced confirmation.** Informational tools run immediately.
  Mutating tools return a single-use, 90-second confirmation token; nothing
  executes until the model calls `confirm_pending(token)` after verbally
  reading the action back to the user. Enforced in `tools.ts`, not by prompt.
- **Sticky target.** `set_target` fuzzy-matches a window (and optional tab) and
  pins it, like the Telegram TopicManager's active thread.
- **Spoken digests.** `digest.ts` converts transcript/state into 2–3 spoken
  sentences via a cheap OpenRouter model, stripping file paths, hashes, URLs,
  and code identifiers.
- **Proactive events.** New pending approvals, agent errors, and
  agent-finished transitions are pushed into the Realtime conversation as
  system items (rate-limited, default 15 s minimum gap) so DICKTATOR speaks up
  unprompted.

Source: `src/server/transports/voice/` (`realtime-bridge.ts`, `tools.ts`,
`digest.ts`, `index.ts`) plus `src/client/voice.js` and relay endpoints
`/api/voice/{token,call,disconnect,status}`.

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

Tests: `npx tsx --test tests/voice-tools.test.ts tests/voice-digest.test.ts`.
