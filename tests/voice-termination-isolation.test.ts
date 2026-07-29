import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { VoiceTransport, type VoiceTerminationStatus } from '../src/server/transports/voice/index.js';
import { FakeHermesConversationReader, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';

/**
 * Termination in-flight state is per session, not per transport.
 *
 * The transport used to hold a single `terminating` promise. While session A's
 * provider hangup was outstanding, a terminate for any *other* key returned
 * A's promise, so a stale caller received A's session id, epoch, provider
 * cleanup state and `providerHangupConfirmed: true` — a confirmation for a call
 * it never owned. Repeated callers for the same key must still share one
 * outcome; a different key must be resolved on its own merits.
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

interface TransportOptions {
  /** Held open until resolved, so a hangup can be kept in flight deterministically. */
  hangupGate?: Promise<void>;
  config?: Parameters<typeof testVoiceConfig>[0];
}

function makeTransport(dir: string, options: TransportOptions = {}): VoiceTransport {
  return new VoiceTransport(testVoiceConfig(options.config), dir, new FakeHermesConversationReader(), {
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/client_secrets')) {
        return new Response(JSON.stringify({ value: 'ephemeral-browser-secret', expires_at: 123 }), { status: 200 });
      }
      if (url.includes('/hangup')) {
        if (options.hangupGate) await options.hangupGate;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected provider call: ${url}`);
    }) as typeof fetch,
    websocketFactory: () => new FakeRealtimeSocket() as unknown as WebSocket,
  });
}

function withDir<T>(name: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Reads the transport's private in-flight map to prove it is not leaked. */
function inFlightSize(transport: VoiceTransport): number {
  const map = (transport as unknown as { terminating: Map<string, Promise<VoiceTerminationStatus>> }).terminating;
  assert.ok(map instanceof Map, 'in-flight terminations must be keyed per session');
  return map.size;
}

describe('voice termination promise isolation', () => {
  it('does not hand a stale terminate the in-flight result of another session', async () => {
    await withDir('voice-terminate-isolation', async (dir) => {
      const gate = deferred<void>();
      const transport = makeTransport(dir, { hangupGate: gate.promise });
      const { sessionId, epoch, attachToken } = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-a', sessionId, epoch, attachToken, 'account-a');

      // A is now parked inside the provider hangup.
      const aFirst = transport.terminate(sessionId, epoch, 'client_request', 'account-a');
      const aSecond = transport.terminate(sessionId, epoch, 'client_request', 'account-a');
      // A key that is not the live session: its own outcome, decided now.
      const bStale = transport.terminate('stale-session-b', 99, 'client_request');

      gate.resolve();
      const [a1, a2, b] = await Promise.all([aFirst, aSecond, bStale]);

      assert.equal(b.providerCallCleanup, 'unknown',
        'a stale terminate must not inherit another session\'s provider cleanup');
      assert.equal(b.providerHangupConfirmed, false,
        'a stale terminate must never report a confirmed hangup it did not perform');
      assert.equal(b.reason, 'stale_session');
      assert.notEqual(b.sessionId, sessionId, 'a stale terminate must not report the live session id');
      assert.notStrictEqual(b, a1, 'the stale caller must not receive session A\'s result object');

      assert.strictEqual(a1, a2, 'repeated callers for the same session share one termination outcome');
      assert.equal(a1.providerCallCleanup, 'confirmed');
      assert.equal(a1.providerHangupConfirmed, true);
      assert.equal(a1.sessionId, sessionId);

      assert.equal(inFlightSize(transport), 0, 'a settled termination must not leak its in-flight entry');
      await transport.stop();
    });
  });

  it('keeps a later session terminable while an earlier one is still in flight', async () => {
    await withDir('voice-terminate-sequence', async (dir) => {
      const gate = deferred<void>();
      const transport = makeTransport(dir, { hangupGate: gate.promise });
      const first = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-a', first.sessionId, first.epoch, first.attachToken, 'account-a');

      const pending = transport.terminate(first.sessionId, first.epoch, 'client_request', 'account-a');
      assert.equal(inFlightSize(transport), 1, 'the live termination is tracked under its own key');

      gate.resolve();
      const settled = await pending;
      assert.equal(settled.providerCallCleanup, 'confirmed');
      assert.equal(inFlightSize(transport), 0);

      // A fresh session must terminate on its own merits, not replay the first.
      const second = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-b', second.sessionId, second.epoch, second.attachToken, 'account-a');
      const secondResult = await transport.terminate(second.sessionId, second.epoch, 'client_request', 'account-a');

      assert.equal(secondResult.sessionId, second.sessionId);
      assert.notEqual(secondResult.epoch, first.epoch);
      assert.equal(inFlightSize(transport), 0);
      await transport.stop();
    });
  });
});

describe('voice reaper termination ownership', () => {
  it('routes a reaper-initiated hangup to the session owner', async () => {
    await withDir('voice-terminate-reaper', async (dir) => {
      // Lease chosen short so the reaper's own interval (min(leaseMs, 5s))
      // fires after the lease has already expired. start() runs after attach,
      // so the first tick is strictly later than the extended lease.
      const transport = makeTransport(dir, { config: { sessionLeaseMs: 200 } });
      const delivered = deferred<{ status: VoiceTerminationStatus; owner: string }>();
      transport.setHangupHandler((status, owner) => { delivered.resolve({ status, owner }); });

      const { sessionId, epoch, attachToken } = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-reaped', sessionId, epoch, attachToken, 'account-a');
      await transport.start();

      const hangup = await delivered.promise;
      // The handler fires inside the termination work, before it resolves; let
      // the creating caller's finally run before reading the in-flight map.
      await new Promise((resolve) => { setImmediate(resolve); });

      assert.equal(hangup.owner, 'account-a',
        'a reaped session announces its hangup to the account that owned it');
      assert.equal(hangup.status.sessionId, sessionId);
      assert.equal(hangup.status.epoch, epoch);
      assert.equal(hangup.status.reason, 'lease_expired');
      assert.equal(hangup.status.providerCallCleanup, 'confirmed');
      assert.equal(inFlightSize(transport), 0);
      await transport.stop();
    });
  });
});
