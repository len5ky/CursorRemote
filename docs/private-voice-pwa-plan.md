# Private voice PWA — implementation plan and delivered contract

Status: **delivered, automated and mock verified.** Live microphone/WebRTC
interoperability against OpenAI still requires a separate, explicitly authorised
operator smoke.

Operator guide: [`private-voice-pwa-deploy.md`](./private-voice-pwa-deploy.md).
Surface overview: [`dicktator.md`](./dicktator.md).

---

## 1. Goal

Replace the mutation-capable "car mode" voice transport with a private,
single-user, **read-only** voice companion for the operator's own Hermes
context, delivered as a one-page installable PWA.

The core insight driving the work: a read-only *prompt* is not a security
boundary. The code graph itself must make mutation impossible.

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

### 2.2 Read-only boundary

- Tool allowlist: `list_sessions`, `get_status`, `get_all_status`,
  `read_recent`, `disconnect_voice`.
- `VoiceToolDeps` carries only `contextReader` and `terminateVoice`. There is no
  mutator to inject.
- `VoiceTransport` has no `CommandExecutor` dependency.
- Legacy mutation names and unknown names both fall through to a stable
  `read_only_denied` result; the sideband stays open.
- Tool results are a closed union: `ok | read_only_denied | context_unavailable
  | stale_session | budget_blocked | invalid_request`. No confirmation outcome
  exists.

### 2.3 Hermes conversation boundary

- `HermesConversationReader` is a read-only interface with no write method.
- Production wires `HttpHermesConversationReader` against
  `HERMES_READ_CONTEXT_URL` (HTTPS or loopback only), with schema validation and
  bounded/redacted output.
- Unconfigured or unreachable ⇒ `{ kind: 'unavailable', reason }`. Never a
  synthetic fixture, never canned text.
- The deterministic double lives in `tests/helpers/voice-fixtures.ts` and cannot
  be selected by production startup.

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
| Staged confirmation (`pendingConfirm`, `confirmLatest`, `deferLatest`, `/api/voice/confirm`, `/api/voice/defer`) | There is no mutation left to stage. |
| Mutation tool set and `CommandExecutor` wiring | Structural severance beats prompt instructions. |
| `digest.ts` + `OPENROUTER_API_KEY` / `VOICE_DIGEST_MODEL` / `VOICE_TTS_MODEL` / `VOICE_STT_MODEL` | Sent conversation content to a second provider. `gpt-realtime-2.1` now summarises the supplied material directly, removing a context-sharing surface and any ambiguity about the exact-model rule. |
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
  legacy name denied, unknown names fail closed, no mutator reachable, sideband
  survives a denial.
- **Ported:** ownership, epoch, admission exclusivity, budget/lease, stale
  events, idempotent hangup, orphan retry, secret hygiene.

New coverage:

| Suite | Covers |
| --- | --- |
| `tests/private-voice-contract.test.ts` | Provider request shape, hashed safety identifier, secret non-leakage, exact-model invariant, `VOICE_MODEL` tripwire, route removal. |
| `tests/voice-tools.test.ts` | Allowlist, read DTO mapping, context-unavailable, bounds validation, legacy/unknown denial, dependency-graph assertions. |
| `tests/voice-ownership.test.ts` | Foreign owner, attach-token replay, stale epoch, unknown session, malformed call id, failed-admission release. |
| `tests/voice-client-lifecycle.test.ts` | 26 deterministic jsdom browser-lifecycle cases: mic denial, token/SDP/attach failure, track cleanup, double-tap, bounded reconnect, server hangup, `pagehide`, barge-in, credential hygiene. |
| `tests/private-voice-smoke.test.ts` | Mocked route/provider lifecycle end to end over real HTTP: auth → token → attach → read tool → denied mutation → hangup → provider ack. |

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

- **Live verification outstanding.** Real microphone/WebRTC interoperability is
  unproven until an authorised operator smoke runs against OpenAI.
- **Android client out of sync.** `apps/dicktator-android` Android Auto
  Approve/Later still call the removed `/api/voice/confirm` and
  `/api/voice/defer` routes and will fail against this server. Its phone call
  path still matches. Aligning or retiring that client is tracked separately.
- **Playwright mobile-viewport smoke** is not wired; browser lifecycle coverage
  is jsdom-based.
