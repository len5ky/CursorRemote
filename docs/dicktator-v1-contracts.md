# DICKTATOR V1 contracts

> **Superseded — historical record.** These contracts describe the earlier
> mutation-capable voice surface. The shipping surface is read-only: staged
> confirmation, the mutation tool set and the `CommandExecutor` dependency have
> been removed, and the model is pinned to `gpt-realtime-2.1` with no fallback.
> For the current contract see [`dicktator.md`](./dicktator.md) and
> [`private-voice-pwa-deploy.md`](./private-voice-pwa-deploy.md). The session,
> epoch, lease and idempotent-termination invariants below still hold.

These contracts are server-authoritative. V1 excludes Android, Auto/capability packs,
automatic model routing, model-switch reconnects, and generalized recovery.

## Session and termination

- A voice session moves only through `idle | admitting | active | terminating |
  terminated | failed`. Legal forward transitions are `idle|terminated|failed →
  admitting → active → terminating → terminated|failed`; terminal states never
  resurrect.
- A session has immutable `sessionId`, `epoch`, and `leaseId`. Provider callbacks,
  tool calls, and termination requests are ignored unless all three match the live
  session (apart from observability).
- `terminate(sessionId, epoch, reason)` is idempotent. Its first valid call revokes
  tool and confirmation authority before bounded best-effort provider cleanup;
  repeats return the current termination result without repeating authority grants.
- Cleanup closes the sideband, requests OpenAI `POST /v1/realtime/calls/{callId}/hangup`,
  releases the lease, and emits `voice:hangup`. A cleanup failure is `failed`, never
  `active`. An expired heartbeat lease is reaped through this same path.

## Voice control and confirmations

- `disconnect_voice` is a dedicated voice-session control dispatcher, never a Cursor
  command alias and never `cancel`, `approve`, or `reject`.
- The Realtime tool schema is a closed explicit allowlist. No model text or dynamic
  method dispatch selects a server capability.
- A confirmation token is single-use and bound to session, epoch, lease, target
  revision, tool, canonical argument digest, and expiry. Consume, revalidate, and
  execute occur atomically; target/session change, expiry, or termination invalidates
  it. Pending tokens are invalidated at terminate.

## Target and health

- `set_target` pins a stable Cursor window identity and target revision, not a title
  alone. A changed target revision invalidates pending confirmations.
- Mutations require `mutationSafe`: `voice`, `sideband`, `socket`, `cdp`, and exact
  selected target health must all be true. Read-only status can be degraded; mutations
  fail closed.
- CDP health means bridge connected, target alive, revision unchanged, and a bounded
  DOM probe succeeds. Window-monitor state is display data, not authorization.

## Budget and idle

- Budget states are `available | budget_draining | hard_exceeded`; idle states are
  `user_active | idle_grace | idle_expired`. Admission requires `available`.
- Ledger admission is server-owned and account-keyed, with an atomic daily cap,
  per-session cap, versioned known pricing, and a conservative reserve. Unknown or
  stale pricing/metering denies a new connection or upgrade.
- `hard_exceeded`, `idle_expired`, and absolute session timeout terminate the epoch.
  Ambient audio and WindowMonitor ticks do not reset idle; assistant speech, committed
  tools, and a bounded confirmation grace may defer it, but never the absolute cap.

## Model policy

`gpt-realtime-2.1` remains the default. A Mini config hook may exist, but V1 does not
route automatically or reconnect on a model switch; Mini becomes default only after a
separate adversarial tool-safety evaluation.

**Non-negotiable invariant:** a stale event, confirmation, lease, or changed Cursor
target must never mutate the current voice session.
