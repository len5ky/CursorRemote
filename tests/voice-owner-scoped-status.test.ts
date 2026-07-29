import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import { FakeHermesAgent, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';
import { startVoiceRelay } from './helpers/voice-relay-harness.js';

/**
 * A terminated session still belongs to the account that ran it.
 *
 * Ownership was resolved through `currentOwner()`, which reports `null` the
 * moment a session reaches a terminal state. So the instant operator A hung up,
 * the ownership gate on `/api/voice/status` fell open and operator B — a
 * different authenticated session on the same relay — was served A's session
 * id, A's epoch, A's lifecycle state and A's budget: what A spent, what A had
 * left, and when A's call started and last moved. That is another operator's
 * private call metadata, handed over by a route whose whole job is to scope it.
 *
 * A must keep seeing its own terminal status idempotently, and the reaper must
 * keep terminating on A's behalf, so the fix cannot simply be to forget the
 * session at termination.
 */

function withDir<T>(name: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function makeTransport(dir: string): VoiceTransport {
  return new VoiceTransport(testVoiceConfig(), dir, new FakeHermesAgent(), {
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/client_secrets')) {
        return new Response(JSON.stringify({ value: 'ephemeral-browser-secret', expires_at: 123, model: 'gpt-realtime-2.1' }), { status: 200 });
      }
      if (url.includes('/hangup')) return new Response(null, { status: 200 });
      throw new Error(`unexpected provider call: ${url}`);
    }) as typeof fetch,
    websocketFactory: () => new FakeRealtimeSocket() as unknown as WebSocket,
  });
}

describe('voice terminated status is owner scoped — transport', () => {
  it('does not expose a terminated session to another owner', async () => {
    await withDir('voice-owner-status-transport', async (dir) => {
      const transport = makeTransport(dir);
      const a = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-a', a.sessionId, a.epoch, a.attachToken, 'account-a');
      const ended = await transport.terminate(a.sessionId, a.epoch, 'client_request', 'account-a');
      assert.equal(ended.state, 'terminated', 'account A ended its own call');

      const seenByB = transport.statusFor('account-b');
      if (seenByB !== null) {
        assert.notEqual(seenByB.sessionId, a.sessionId, "account B must not be told account A's session id");
        assert.notEqual(seenByB.epoch, a.epoch, "account B must not be told account A's epoch");
        assert.equal(seenByB.state, 'idle', "account B must not be told account A's lifecycle state");
        assert.equal(seenByB.budget.estimatedCents, 0, "account B must not be told account A's spend");
        assert.equal(seenByB.budget.reservationCents, 0, "account B must not be told account A's reservation");
      }

      await transport.stop();
    });
  });

  it('still reports the terminal status idempotently to the owner', async () => {
    await withDir('voice-owner-status-idempotent', async (dir) => {
      const transport = makeTransport(dir);
      const a = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-a', a.sessionId, a.epoch, a.attachToken, 'account-a');
      await transport.terminate(a.sessionId, a.epoch, 'client_request', 'account-a');

      const first = transport.statusFor('account-a');
      const second = transport.statusFor('account-a');
      assert.ok(first, 'the owner can still read its own terminal status');
      assert.ok(second, 'the owner can read it again');
      assert.equal(first.sessionId, a.sessionId);
      assert.equal(first.epoch, a.epoch);
      assert.equal(first.state, 'terminated');
      assert.deepEqual(second, first, 'a repeated read of a terminal status is idempotent');

      await transport.stop();
    });
  });

  it('serves a fresh owner an empty status when no session has ever run', async () => {
    await withDir('voice-owner-status-fresh', async (dir) => {
      const transport = makeTransport(dir);
      const fresh = transport.statusFor('account-b');
      assert.ok(fresh, 'an idle relay is readable by any authenticated owner');
      assert.equal(fresh.sessionId, null);
      assert.equal(fresh.state, 'idle');
      await transport.stop();
    });
  });

  it('keeps the owner idempotency of terminate itself', async () => {
    await withDir('voice-owner-terminate-idempotent', async (dir) => {
      const transport = makeTransport(dir);
      const a = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-a', a.sessionId, a.epoch, a.attachToken, 'account-a');

      const first = await transport.terminate(a.sessionId, a.epoch, 'client_request', 'account-a');
      const second = await transport.terminate(a.sessionId, a.epoch, 'client_request', 'account-a');
      assert.deepEqual(second, first, 'a repeated terminate by the owner returns the same outcome');

      await assert.rejects(
        () => transport.terminate(a.sessionId, a.epoch, 'client_request', 'account-b'),
        (err: NodeJS.ErrnoException & { statusCode?: number }) => err.statusCode === 403,
        "another owner may not terminate, or observe, account A's completed session",
      );

      await transport.stop();
    });
  });

  /**
   * The transport is single-session, so the account that owns it changes as
   * soon as the next operator is admitted. Ownership of an *already completed*
   * termination must not move with it: the completed record still holds the
   * previous operator's session id, epoch, provider-cleanup state and reason,
   * and it is still cached and returned by `terminate()` for that key.
   */
  it("does not transfer a completed termination to whoever admits next", async () => {
    await withDir('voice-owner-terminate-handover', async (dir) => {
      const transport = makeTransport(dir);
      const a = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-a', a.sessionId, a.epoch, a.attachToken, 'account-a');
      const ended = await transport.terminate(a.sessionId, a.epoch, 'client_request', 'account-a');
      assert.equal(ended.state, 'terminated');

      // A different operator now takes the transport.
      const b = await transport.mintClientSecret('account-b');
      assert.notEqual(b.sessionId, a.sessionId);

      await assert.rejects(
        () => transport.terminate(a.sessionId, a.epoch, 'client_request', 'account-b'),
        (err: NodeJS.ErrnoException & { statusCode?: number }) => err.statusCode === 403,
        "holding the current session must not grant access to another operator's completed termination",
      );

      const replayed = await transport.terminate(a.sessionId, a.epoch, 'client_request', 'account-a');
      assert.deepEqual(
        replayed,
        ended,
        'account A keeps idempotent access to its own completed termination after a handover',
      );

      assert.equal(
        transport.statusFor('account-a'),
        null,
        "account A must not be shown account B's live session status",
      );
      const bStatus = transport.statusFor('account-b');
      assert.ok(bStatus);
      assert.equal(bStatus.sessionId, b.sessionId);

      await transport.stop();
    });
  });
});

describe('voice terminated status is owner scoped — route', () => {
  it('does not serve one operator the terminated session of another', async () => {
    const harness = await startVoiceRelay();
    try {
      const cookieA = await harness.login();
      const cookieB = await harness.login();
      assert.notEqual(cookieA, cookieB, 'the harness produced two distinct authenticated sessions');

      const minted = await harness.raw({
        method: 'POST',
        path: '/api/voice/token',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(minted.status, 200, minted.body);
      const session = JSON.parse(minted.body) as { sessionId: string; epoch: number };

      const ended = await harness.raw({
        method: 'POST',
        path: '/api/voice/terminate',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, epoch: session.epoch }),
      });
      assert.equal(ended.status, 200, ended.body);

      const statusB = await harness.raw({
        method: 'GET',
        path: '/api/voice/status',
        headers: { Cookie: cookieB },
      });
      assert.ok(
        !statusB.body.includes(session.sessionId),
        `operator B must never receive operator A's session id; got ${statusB.body}`,
      );
      if (statusB.status === 200) {
        const body = JSON.parse(statusB.body) as {
          sessionId: string | null;
          epoch: number | null;
          state: string;
          estimatedSpendCents: number;
        };
        assert.equal(body.sessionId, null);
        assert.equal(body.epoch, null);
        assert.equal(body.state, 'idle');
        assert.equal(body.estimatedSpendCents, 0);
      }

      const statusA = await harness.raw({
        method: 'GET',
        path: '/api/voice/status',
        headers: { Cookie: cookieA },
      });
      assert.equal(statusA.status, 200, statusA.body);
      const ownBody = JSON.parse(statusA.body) as { sessionId: string | null; epoch: number | null; state: string };
      assert.equal(ownBody.sessionId, session.sessionId, 'the owner still sees its own terminal status');
      assert.equal(ownBody.epoch, session.epoch);
      assert.equal(ownBody.state, 'terminated');
    } finally {
      await harness.close();
    }
  });

  it('refuses a cross-owner terminate of a completed session without leaking it', async () => {
    const harness = await startVoiceRelay();
    try {
      const cookieA = await harness.login();
      const cookieB = await harness.login();

      const minted = await harness.raw({
        method: 'POST',
        path: '/api/voice/token',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(minted.status, 200, minted.body);
      const session = JSON.parse(minted.body) as { sessionId: string; epoch: number };
      const body = JSON.stringify({ sessionId: session.sessionId, epoch: session.epoch });

      const first = await harness.raw({
        method: 'POST',
        path: '/api/voice/terminate',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(first.status, 200, first.body);

      const again = await harness.raw({
        method: 'POST',
        path: '/api/voice/terminate',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(again.status, 200, 'the owner may re-terminate its own session');
      assert.deepEqual(JSON.parse(again.body), JSON.parse(first.body), 'the terminal outcome is idempotent');

      const crossOwner = await harness.raw({
        method: 'POST',
        path: '/api/voice/terminate',
        headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(crossOwner.status, 403, crossOwner.body);
      assert.ok(
        !crossOwner.body.includes(session.sessionId),
        "a refused cross-owner terminate must not echo the other operator's session id",
      );
    } finally {
      await harness.close();
    }
  });
});
