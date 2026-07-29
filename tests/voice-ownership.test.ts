import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceSessionController } from '../src/server/transports/voice/session.js';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import type WebSocket from 'ws';
import { FakeHermesConversationReader, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';
import { KNOWN_VOICE_PRICE_VERSION } from '../src/server/transports/voice/pricing.js';

function makeController(nowRef: { value: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-own-'));
  const controller = new VoiceSessionController({
    dataPath: join(dir, 'voice-usage.json'),
    priceVersion: KNOWN_VOICE_PRICE_VERSION,
    unitPriceCentsPerMinute: 1,
    dailyCapCents: 100,
    perSessionCapCents: 10,
    absoluteSessionMs: 10 * 60_000,
    idleMs: 60_000,
    idleGraceMs: 5_000,
    leaseMs: 30_000,
  }, () => nowRef.value);
  return { controller, dir };
}

/**
 * Every transport in this suite injects provider doubles. No test in this file
 * is capable of reaching api.openai.com.
 */
function makeTransport(
  dir: string,
  options: { mintStatus?: number; sidebandWorks?: boolean } = {},
): VoiceTransport {
  const mintStatus = options.mintStatus ?? 200;
  return new VoiceTransport(testVoiceConfig(), dir, new FakeHermesConversationReader(), {
    fetchImpl: (async () => (mintStatus === 200
      ? new Response(JSON.stringify({ value: 'ephemeral-browser-secret', expires_at: 123 }), { status: 200 })
      : new Response('nope', { status: mintStatus }))) as typeof fetch,
    websocketFactory: options.sidebandWorks
      ? (() => new FakeRealtimeSocket() as unknown as WebSocket)
      : (() => { throw new Error('provider sideband unavailable in tests'); }),
  });
}

describe('voice account ownership boundary', () => {
  it('currentOwner returns accountKey from admit and null after termination', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now);
    try {
      assert.equal(controller.currentOwner(), null, 'idle controller has no owner');

      const admittedA = controller.admit('account-a');
      assert.equal(admittedA.ok, true);
      const ctxA = admittedA.context!;

      assert.equal(controller.currentOwner(), 'account-a');
      assert.equal(controller.activate(ctxA), true);
      assert.equal(controller.accept(ctxA), true);
      assert.notEqual(controller.currentOwner(), 'account-b');

      assert.equal(controller.heartbeat(ctxA.sessionId, ctxA.epoch), true);

      controller.beginTermination(ctxA);
      controller.finishTermination(ctxA, true);
      assert.equal(controller.currentOwner(), null, 'owner null after termination');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proves live session A cannot be operated by account B', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-own2-'));
    try {
      const transport = makeTransport(dir);
      {
        const { sessionId, epoch, attachToken } = await transport.mintClientSecret('account-a');

        // B cannot attach, even holding a syntactically valid grant token.
        await assert.rejects(
          () => transport.attachCall('call-attach-by-b', sessionId, epoch, attachToken, 'account-b'),
          (err: NodeJS.ErrnoException & { statusCode?: number }) => err?.statusCode === 403,
          'B attachCall throws 403 on a session it does not own',
        );

        const sessions = (transport as unknown as { sessions: VoiceSessionController }).sessions;
        assert.equal(sessions.activate(sessions.currentContext()!), true);

        // B cannot heartbeat — non-disclosing false rather than an error.
        assert.equal(transport.heartbeat(sessionId, epoch, 'account-b'), false);

        await assert.rejects(
          () => transport.terminate(sessionId, epoch, 'test-by-b', 'account-b'),
          (err: NodeJS.ErrnoException & { statusCode?: number }) => err?.statusCode === 403,
          'B terminate throws 403',
        );

        assert.equal(transport.statusFor('account-b'), null, 'B statusFor returns null');

        // A remains fully in control of its own session.
        assert.equal(transport.heartbeat(sessionId, epoch, 'account-a'), true);
        const aStatus = transport.statusFor('account-a');
        assert.notEqual(aStatus, null);
        assert.equal(aStatus?.sessionId, sessionId);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the cached termination to its owner after the session releases ownership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-own3-'));
    try {
      const transport = makeTransport(dir);
      const sessions = (transport as unknown as { sessions: VoiceSessionController }).sessions;
      const admitted = sessions.admit('account-a');
      assert.equal(admitted.ok, true);
      const context = admitted.context!;
      assert.equal(sessions.activate(context), true);

      const first = await transport.terminate(context.sessionId, context.epoch, 'client_request', 'account-a');
      const repeat = await transport.terminate(context.sessionId, context.epoch, 'client_request', 'account-a');
      assert.deepEqual(repeat, first, 'repeated hangup is idempotent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('voice attach grant', () => {
  it('consumes the attach token exactly once so a replay cannot attach twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-attach1-'));
    try {
      const transport = makeTransport(dir, { sidebandWorks: true });
      {
        const { sessionId, epoch, attachToken } = await transport.mintClientSecret('account-a');
        // First attach succeeds and the session stays live, so the replay can
        // only be refused because the one-time grant was already consumed.
        await transport.attachCall('call-1', sessionId, epoch, attachToken, 'account-a');

        await assert.rejects(
          () => transport.attachCall('call-1', sessionId, epoch, attachToken, 'account-a'),
          /grant is invalid or expired/,
          'a replayed attach token must be refused',
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a stale epoch, an unknown session and a malformed call id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-attach2-'));
    try {
      const transport = makeTransport(dir);
      {
        const { sessionId, epoch, attachToken } = await transport.mintClientSecret('account-a');
        await assert.rejects(
          () => transport.attachCall('call-1', sessionId, epoch + 1, attachToken, 'account-a'),
          /grant is invalid or expired/,
          'a stale epoch must not attach',
        );
        await assert.rejects(
          () => transport.attachCall('call-1', 'some-other-session', epoch, attachToken, 'account-a'),
          /grant is invalid or expired/,
          'an unknown session must not attach',
        );
        await assert.rejects(
          () => transport.attachCall('call id with spaces', sessionId, epoch, attachToken, 'account-a'),
          /invalid call id/,
          'a malformed provider call id must be refused',
        );
        await assert.rejects(
          () => transport.attachCall('call-1', sessionId, epoch, 'short', 'account-a'),
          /invalid attach token/,
          'an undersized attach token must be refused',
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases the admitted session when provider admission fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-attach3-'));
    try {
      const transport = makeTransport(dir, { mintStatus: 500 });
      await assert.rejects(() => transport.mintClientSecret('account-a'));
      // A failed mint must not strand an admitted session holding the slot.
      assert.equal(transport.currentOwner, null, 'failed admission releases ownership');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
