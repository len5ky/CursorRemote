import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { VoiceTransport, type VoiceTerminationStatus } from '../src/server/transports/voice/index.js';
import { FakeHermesConversationReader, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';
import type { VoiceConfig } from '../src/server/types.js';

/**
 * In-flight termination work belongs to one session, not to the transport.
 *
 * The transport held a single `terminating` promise and returned it to *any*
 * caller that arrived while a termination was running. A request to end
 * session B therefore resolved with session A's status object — A's session id,
 * A's epoch, A's termination reason and A's provider-cleanup state — and B's
 * caller believed it had ended its own call. The work has to be keyed per
 * session so one session can never be handed another's promise or result.
 *
 * The reaper terminates without naming an owner, so the owner has to be
 * resolved from the live session at termination time; otherwise a lease-expiry
 * hangup is announced against the wrong routing key (or none at all) and never
 * reaches the operator whose call actually ended.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Let every already-queued microtask and timer callback drain. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

interface TransportHandles {
  transport: VoiceTransport;
  /** Resolve to release a hangup that is deliberately held open. */
  releaseHangup: () => void;
  hangupCalls: string[];
}

function makeTransport(
  dir: string,
  options: { holdHangup?: boolean; config?: Partial<VoiceConfig> } = {},
): TransportHandles {
  const gate = deferred<void>();
  const hangupCalls: string[] = [];
  const transport = new VoiceTransport(
    testVoiceConfig(options.config),
    dir,
    new FakeHermesConversationReader(),
    {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/client_secrets')) {
          return new Response(JSON.stringify({ value: 'ephemeral-browser-secret', expires_at: 123 }), { status: 200 });
        }
        if (url.includes('/hangup')) {
          hangupCalls.push(url);
          if (options.holdHangup) await gate.promise;
          return new Response(null, { status: 200 });
        }
        throw new Error(`unexpected provider call: ${url}`);
      }) as typeof fetch,
      websocketFactory: () => new FakeRealtimeSocket() as unknown as WebSocket,
    },
  );
  return { transport, releaseHangup: () => gate.resolve(), hangupCalls };
}

function withDir<T>(name: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('voice termination — in-flight work is keyed per session', () => {
  it('never hands one session\'s termination promise to a caller ending a different session', async () => {
    await withDir('voice-term-crosstalk', async (dir) => {
      const { transport, releaseHangup } = makeTransport(dir, { holdHangup: true });
      const live = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-live', live.sessionId, live.epoch, live.attachToken, 'account-a');

      // A's termination parks inside the provider hangup and stays in flight.
      const pendingLive = transport.terminate(live.sessionId, live.epoch, 'client_request', 'account-a');
      await settle();

      // A different session id arrives while A is still terminating.
      const pendingOther = transport.terminate('some-other-session', 7, 'client_request');

      releaseHangup();
      const [liveResult, otherResult] = await Promise.all([pendingLive, pendingOther]);

      assert.equal(liveResult.sessionId, live.sessionId, 'A still gets its own result');
      assert.notEqual(
        otherResult.sessionId,
        live.sessionId,
        "a caller terminating another session must never receive the live session's identity",
      );
      assert.notEqual(
        otherResult.epoch,
        live.epoch,
        "a caller terminating another session must never receive the live session's epoch",
      );
      assert.equal(
        otherResult.providerHangupConfirmed,
        false,
        'an unrelated session may not inherit a confirmed provider hangup',
      );
      await transport.stop();
    });
  });

  it('still collapses concurrent terminations of the same session onto one outcome', async () => {
    await withDir('voice-term-idempotent', async (dir) => {
      const { transport, releaseHangup, hangupCalls } = makeTransport(dir, { holdHangup: true });
      const live = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-same', live.sessionId, live.epoch, live.attachToken, 'account-a');

      const first = transport.terminate(live.sessionId, live.epoch, 'client_request', 'account-a');
      await settle();
      const second = transport.terminate(live.sessionId, live.epoch, 'client_request', 'account-a');

      releaseHangup();
      const [a, b] = await Promise.all([first, second]);

      assert.equal(a.sessionId, live.sessionId);
      assert.equal(b.sessionId, live.sessionId);
      assert.equal(b.epoch, live.epoch);
      assert.equal(
        hangupCalls.length,
        1,
        'the provider call is hung up once, not once per concurrent request',
      );
      await transport.stop();
    });
  });

  it('does not leak the live session identity to a stale terminate request', async () => {
    await withDir('voice-term-stale', async (dir) => {
      const { transport } = makeTransport(dir);
      const live = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-stale', live.sessionId, live.epoch, live.attachToken, 'account-a');

      // No owner supplied, exactly as an internal/reaper caller would.
      const stale = await transport.terminate('a-session-that-never-existed', 3, 'client_request');

      assert.equal(stale.reason, 'stale_session');
      assert.notEqual(
        stale.sessionId,
        live.sessionId,
        'a stale request must not be answered with the live session id',
      );
      assert.equal(stale.providerHangupConfirmed, false);
      await transport.stop();
    });
  });
});

describe('voice termination — reaper preserves owner semantics', () => {
  it('announces a lease-expiry hangup against the owning account, not a default key', async () => {
    await withDir('voice-term-reaper', async (dir) => {
      // A lease this short expires between reaper ticks without any clock stubbing.
      const { transport } = makeTransport(dir, {
        config: { sessionLeaseMs: 60, sessionIdleMs: 60, sessionIdleGraceMs: 10 },
      });
      const announced: Array<{ status: VoiceTerminationStatus; owner: string }> = [];
      transport.setHangupHandler((status, owner) => { announced.push({ status, owner }); });

      const live = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-reaped', live.sessionId, live.epoch, live.attachToken, 'account-a');

      await transport.start();
      // Long enough for the lease to expire and a reaper tick to fire.
      await new Promise((resolve) => setTimeout(resolve, 400));
      await transport.stop();

      assert.ok(announced.length > 0, 'the reaper must announce the hangup it performed');
      const reaped = announced[0];
      assert.equal(
        reaped.owner,
        'account-a',
        'a reaped session is announced to the account that owned it',
      );
      assert.equal(reaped.status.sessionId, live.sessionId);
      assert.equal(reaped.status.epoch, live.epoch);
      assert.match(
        reaped.status.reason,
        /lease_expired|idle_timeout|hard_exceeded|transport_stop/,
        'the reaper reports why it ended the session',
      );
    });
  });
});
