# Private voice PWA — implementation plan and delivered contract

Status: **delivered, automated and mock verified.** Live microphone/WebRTC
interoperability against OpenAI, and the live Hermes deployment's capabilities
and session-chat contract, still require a separate, explicitly authorised
operator smoke.

Operator guide: [`private-voice-pwa-deploy.md`](./private-voice-pwa-deploy.md).
Surface overview: [`dicktator.md`](./dicktator.md).

---

## 1. Goal

Replace the mutation-capable "car mode" voice transport with a private,
single-user, **read-only** voice companion for the operator's own Hermes
deployment, delivered as a one-page installable PWA.

Two insights drove the work, and the second one arrived late enough to require a
correction of the first delivery.

**A read-only *prompt* is not a security boundary.** The code graph itself must
make mutation impossible.

**A Realtime model with tools is not a phone line to your assistant — it *is*
the assistant.** The first delivery gave the provider a read-only tool set and
let it hold the conversation, quoting Hermes context when it felt like it. That
is a different product: the operator believes they are talking to Hermes, and
they are talking to `gpt-realtime-2.1` doing an impression of it, with Hermes
demoted to an optional source. The corrected architecture makes the provider
**ears and mouth only** — transcription in, audio rendering out — and makes the
private Hermes deployment the sole conversational authority.

---

## 2. Delivered contract

### 2.1 Model

- Every Realtime session is pinned to `gpt-realtime-2.1` via a single constant,
  `VOICE_REALTIME_MODEL` (`src/server/transports/voice/constants.ts`).
- `VoiceConfig` has **no** `model` or `miniModel` field — there is nothing to
  override.
- `VOICE_MODEL` remains only as a startup tripwire: any other value throws at
  `loadConfig()`.
- No alias, preview, mini, fallback, or retry-against-another-model path exists.

### 2.2 The provider is ears and mouth only

- Session config: `tools: []`, `tool_choice: 'none'`, input transcription
  enabled (pinned ASR model `whisper-1`, which is never asked to answer
  anything), and server VAD with `create_response: false` and
  `interrupt_response: false`.
- There is no tool router, no tool schema, and no `VoiceToolDeps` — the modules
  are deleted, not emptied. A function call the session never offered is refused
  outright (`provider_tool_call_refused`) and ends the session; it is never
  answered, because answering would write a tool output for a tool that does not
  exist.
- Hangup remains an authenticated HTTP route. It is deliberately **not** a
  Realtime tool: a tool is something the model can decide to invoke mid-sentence.
- The browser never calls `response.create` and never supplies response
  instructions. It may send `response.cancel` for audio it can hear; that is a
  courtesy, not a boundary.

### 2.3 Hermes is the only conversational authority

- Trigger: `conversation.item.input_audio_transcription.completed`, and nothing
  else. Not `input_audio_buffer.committed`, not `speech_started` — those are
  sound, not language. Deduped by `item_id`.
- The transcript is validated (type, trim, non-empty, UTF-8 byte bound) and sent
  **verbatim** — over-bound is refused, never truncated, because half a question
  answered confidently is a fabrication.
- Route, and the only supported one:
  `POST {VOICE_HERMES_API_URL}/api/sessions/{session_id}/chat`, with
  `Authorization: Bearer {VOICE_HERMES_API_KEY}` and a stable
  `X-Hermes-Session-Key`, carrying `{ "message": "<transcript>" }`. Built by one
  exported helper (`buildHermesChatRequest`) so there is one place to get it
  wrong.
- The response is validated and bounded: assistant content in `content` (or
  `message.content`), optional effective/rotated `session_id` which the relay
  adopts for subsequent turns. Anything else is refused and **nothing is
  spoken**. There is no fallback, canned or synthesised answer anywhere.
- Rendering: an out-of-band `response.create` with `conversation: 'none'`,
  `output_modalities: ['audio']`, explicit custom input carrying the validated
  Hermes text, `metadata: { source: 'hermes', turn_id }`, and instructions to
  read only that text.
- Session identity is **server state**. There is no setter, no request field and
  no client-visible path by which a browser can choose, supply or observe it.

### 2.3.1 Deployment is the enforcement point

Hermes session chat has **no per-request tool disable**. There is no flag the
relay can send to make a shared Hermes behave read-only for one call, so V1
requires a dedicated/private Hermes API-server deployment with MCP disabled and
exactly zero effective toolsets in the documented `/v1/toolsets` response. A
named read-only toolset is a label the relay cannot verify, so it is not
certified either; the Hermes `no_mcp` sentinel is the deployment configuration
for this posture.

The relay reads both reports — `GET HERMES_CAPABILITIES_PATH`
(`/v1/capabilities`) and `GET HERMES_TOOLSETS_PATH` (`/v1/toolsets`) — using the
bounded `VOICE_HERMES_POLICY_TIMEOUT_MS` probe timeout, at boot and before
admission, and **fails closed**: an unreachable report, an undeclared field or a
permissive one all deny the call before any provider I/O or spend. A system
prompt asking Hermes not to use tools is never treated as enforcement.

Startup is honest about this. A transport that cannot place a call does not log
"ready"; it logs `UNAVAILABLE` with the failing reason, `/api/voice/status`
reports `hermesCertified: false`, and `POST /api/voice/token` answers **503**
(deliberate refusal on an unmet precondition) rather than 500. The relay's other
surfaces keep running — a Hermes blip must not take down the web and Telegram
transports.

### 2.3.2 Turn semantics, and the limit of cancellation

- Monotonic `turnId`; latest speech wins.
- `speech_started` or a new transcript aborts the outstanding Hermes fetch,
  invalidates that turn locally, and cancels any Hermes rendering being spoken
  **by response id**.
- **The limit:** aborting the relay's fetch does not cancel a run Hermes has
  already started upstream. Hermes may keep working, finish, and bill for it.
  The guarantee is narrower and is the audible part — a superseded answer is
  never spoken. The supported session-chat interface offers no upstream
  cancellation, so this is a property of the design, not a gap awaiting a patch.

### 2.4 Session and credential invariants

- One session at a time; random `sessionId` plus monotonic `epoch`.
- Sideband events and tool calls accepted only for the current id and epoch.
- Attach grant is one-time, bound to owner/session/epoch, and consumed **before**
  provider I/O so replays cannot attach twice.
- Hangup is idempotent; orphaned provider hangups are retried and reported
  honestly as unconfirmed rather than as verified teardown.
- Standard key is server-only. The ephemeral credential is returned once, held
  in memory, and never logged, persisted, URL-embedded or cached.
- Safety identifier sent to the provider is a stable SHA-256 digest of the
  account key, never the raw key.

### 2.5 Phone surface

- **Browser PWA only for V1.** The supported client is the installable browser
  PWA at `/voice`, including when installed from Chrome on Android. Native
  Android and Android Auto clients are unsupported, not built, not tested and
  not shipped for V1.
- One screen: title, state line, one Call/Hang up button, one status line.
- States: Ready, Microphone requested, Connecting, Listening, Speaking,
  Reconnecting, Ending, Ended, Error.
- Microphone requested from the user gesture, before minting.
- Live only after WebRTC **and** sideband attach both succeed.
- One idempotent cleanup path stops every local track on every terminal path.
- Reconnect bounded to one attempt **per call** with a fresh credential and new
  epoch; never after explicit hangup or a server-side hangup.
- `pagehide` best-effort cleanup via `sendBeacon`; the server lease reaper stays
  authoritative.
- Network-only service worker; caches nothing.

---

## 3. What was removed, and why

| Removed | Reason |
| --- | --- |
| The read-only Realtime tool set, `VoiceToolRouter`, `VoiceToolDeps`, `tools.ts` | They made the provider the assistant. Hermes is the conversational authority now, and the provider has no tools to hold a conversation with. |
| `HermesConversationReader`, `HttpHermesConversationReader`, `context.ts`, `HERMES_READ_CONTEXT_URL` / `HERMES_READ_CONTEXT_TOKEN` | Voice no longer *reads* a context snapshot for a model to paraphrase; it *asks* the private deployment and speaks the answer it gets back. |
| Staged confirmation (`pendingConfirm`, `confirmLatest`, `deferLatest`, `/api/voice/confirm`, `/api/voice/defer`) | There is no mutation left to stage. |
| Mutation tool set and `CommandExecutor` wiring | Structural severance beats prompt instructions. |
| `digest.ts` + `OPENROUTER_API_KEY` / `VOICE_DIGEST_MODEL` / `VOICE_TTS_MODEL` / `VOICE_STT_MODEL` | Sent conversation content to a second provider. Removing it removed a context-sharing surface and any ambiguity about the exact-model rule. |
| `VOICE_PROACTIVE_MIN_INTERVAL_MS` and proactive announcements | Out of scope for a read-only companion. |

`providerConfirmed` was **not** deleted — it was never part of staged
confirmation. It is the result of `RealtimeBridge.hangup` and is now named
`providerHangupConfirmed`.

---

## 4. Test strategy

Legacy failures were classified rather than deleted wholesale:

- **Deleted:** tests asserting a removed positive mutation capability, together
  with the production code they covered (`tests/voice-digest.test.ts` with
  `digest.ts`).
- **Inverted:** old positive mutation tests became negative policy tests — every
  legacy name denied, unknown names fail closed, no mutator reachable.
- **Re-aimed at the corrected contract:** suites whose *subject* was deleted
  were rewritten against the module that replaced it rather than dropped. The
  tool-router suite became a structural-removal suite; the read-context bounds
  suite became Hermes transcript/answer byte bounds; the failure-opacity suite
  now proves a failed Hermes turn is silent and its reason never reaches the
  provider. The invariant each one existed to protect is still asserted; only
  the surface it points at moved.
- **Ported:** ownership, epoch, admission exclusivity, budget/lease, stale
  events, idempotent hangup, orphan retry, secret hygiene.

New coverage:

| Suite | Covers |
| --- | --- |
| `tests/private-voice-contract.test.ts` | Provider request shape, hashed safety identifier, secret non-leakage, exact-model invariant, `VOICE_MODEL` tripwire, route removal. |
| `tests/voice-tools.test.ts` | Structural removal of the tool surface: no router, no schema, no legacy name anywhere in source; every function call refused. |
| `tests/voice-hermes-chat-contract.test.ts` | Exact route/headers/body, stable server-side mapping, rotated session id, bounded response validation, credential non-leakage, capability/tool policy, route ownership and layering. |
| `tests/voice-hermes-turn.test.ts` | Session config invariants, final-transcript-only trigger, dedupe, injection shape, turn ids, barge-in, no fallback. |
| `tests/voice-hermes-admission.test.ts` | Fail-closed admission and startup honesty, 503 on refusal, Hermes identity immutability, credential redaction in logs. |
| `tests/voice-ownership.test.ts` | Foreign owner, attach-token replay, stale epoch, unknown session, malformed call id, failed-admission release. |
| `tests/voice-client-lifecycle.test.ts` | 26 deterministic jsdom browser-lifecycle cases: mic denial, token/SDP/attach failure, track cleanup, double-tap, bounded reconnect, server hangup, `pagehide`, barge-in, credential hygiene. |
| `tests/private-voice-smoke.test.ts` | Mocked route/provider lifecycle end to end over real HTTP: auth → token → attach → final transcript → Hermes answer → denied provider function call → hangup → provider ack. |

`tsconfig.test.json` typechecks `src` **and** `tests`. The base `tsconfig.json`
only included `src/**/*`, which had been hiding 20 type errors in the test
corpus.

---

## 5. Release gates

All must be green, with no skipped tests:

```bash
npx tsc --noEmit                                  # strict typecheck (src)
npx tsc -p tsconfig.test.json --noEmit            # strict typecheck (src + tests)
npm test                                          # full suite, zero skips
npm run build                                     # production build
npx tsx --test tests/private-voice-smoke.test.ts  # mocked provider lifecycle
git diff --check                                  # whitespace/conflict markers
```

No automated step makes an OpenAI Realtime call.

---

## 6. Known gaps

- **Live verification outstanding.** Real microphone/WebRTC interoperability,
  and the real Hermes deployment's capabilities report and session-chat
  response shape, are unproven until an authorised operator smoke runs against
  the live systems. Everything below is mock-verified only.
- **Upstream Hermes runs cannot be cancelled** (§ 2.3.2). The relay can stop
  listening and stop speaking; it cannot un-ask the question.
- **Native Android/Auto unsupported for V1.** The archived
  `apps/dicktator-android` client targets the removed mutation-capable contract;
  its Android Auto Approve/Later controls call `/api/voice/confirm` and
  `/api/voice/defer`, which are not served. It is not part of the V1 product,
  and any native port or retirement is future work. Use the browser PWA at
  `/voice` instead.
- **Playwright mobile-viewport smoke** is not wired; browser lifecycle coverage
  is jsdom-based.
