import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import type { VoiceSessionController } from '../src/server/transports/voice/session.js';
import { FakeHermesAgent, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';

/**
 * `providerHangupConfirmed` used to be `callId ? await hangup(callId) : true`,
 * so a session that never reached the provider — or whose provider call id was
 * already lost — reported a confirmed provider hangup that nobody had
 * performed. Absence of a call id is not confirmation; it is a distinct,
 * explicitly represented outcome.
 */

interface TransportOptions {
  mintStatus?: number;
  hangupStatus?: number;
  sidebandFails?: boolean;
}

function makeTransport(dir: string, options: TransportOptions = {}): VoiceTransport {
  return new VoiceTransport(testVoiceConfig(), dir, new FakeHermesAgent(), {
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/client_secrets')) {
        const status = options.mintStatus ?? 200;
        return status === 200
          ? new Response(JSON.stringify({ value: 'ephemeral-browser-secret', expires_at: 123, model: 'gpt-realtime-2.1' }), { status: 200 })
          : new Response('nope', { status });
      }
      if (url.includes('/hangup')) return new Response(null, { status: options.hangupStatus ?? 200 });
      throw new Error(`unexpected provider call: ${url}`);
    }) as typeof fetch,
    websocketFactory: () => {
      if (options.sidebandFails) throw new Error('provider sideband unavailable in tests');
      return new FakeRealtimeSocket() as unknown as WebSocket;
    },
  });
}

function withDir<T>(name: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('voice provider hangup integrity', () => {
  it('does not claim a provider hangup for a session that never reached the provider', async () => {
    await withDir('voice-hangup-nocall', async (dir) => {
      const transport = makeTransport(dir);
      const sessions = (transport as unknown as { sessions: VoiceSessionController }).sessions;
      const admitted = sessions.admit('account-a');
      const context = admitted.context!;
      assert.equal(sessions.activate(context), true);

      const result = await transport.terminate(context.sessionId, context.epoch, 'client_request', 'account-a');

      assert.equal(result.providerCallCleanup, 'no_provider_call',
        'never having a provider call is its own outcome');
      assert.equal(result.providerHangupConfirmed, false,
        'no provider hangup happened, so none may be reported as confirmed');
      assert.equal(result.state, 'terminated',
        'a session with nothing to clean up still terminates cleanly');
    });
  });

  it('reports an unresolved provider call when the hangup is never acknowledged', async () => {
    await withDir('voice-hangup-unresolved', async (dir) => {
      const transport = makeTransport(dir, { hangupStatus: 500 });
      const { sessionId, epoch, attachToken } = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-1', sessionId, epoch, attachToken, 'account-a');

      const result = await transport.terminate(sessionId, epoch, 'client_request', 'account-a');

      assert.equal(result.providerCallCleanup, 'unresolved');
      assert.equal(result.providerHangupConfirmed, false);
      assert.equal(result.state, 'failed', 'an unresolved provider call must not look like a clean shutdown');
      await transport.stop();
    });
  });

  it('confirms a real acknowledged provider hangup', async () => {
    await withDir('voice-hangup-confirmed', async (dir) => {
      const transport = makeTransport(dir);
      const { sessionId, epoch, attachToken } = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-1', sessionId, epoch, attachToken, 'account-a');

      const result = await transport.terminate(sessionId, epoch, 'client_request', 'account-a');

      assert.equal(result.providerCallCleanup, 'confirmed');
      assert.equal(result.providerHangupConfirmed, true);
      assert.equal(result.state, 'terminated');
    });
  });

  it('does not fabricate confirmation for a stale or unknown session', async () => {
    await withDir('voice-hangup-stale', async (dir) => {
      const transport = makeTransport(dir);
      const result = await transport.terminate('no-such-session', 1, 'client_request');

      assert.equal(result.reason, 'stale_session');
      assert.equal(result.providerCallCleanup, 'unknown');
      assert.equal(result.providerHangupConfirmed, false);
    });
  });

  it('releases and honestly reports a failed provider admission', async () => {
    await withDir('voice-hangup-admission', async (dir) => {
      const transport = makeTransport(dir, { mintStatus: 500 });
      await assert.rejects(() => transport.mintClientSecret('account-a'));

      assert.equal(transport.currentOwner, null, 'a failed mint must not strand the session slot');

      const status = transport.status;
      assert.equal(status.state, 'failed', 'a failed admission is a failed session, not a terminated one');
      assert.equal(status.connected, false);
    });
  });

  it('honestly reports a failed sideband attach', async () => {
    await withDir('voice-hangup-attach', async (dir) => {
      const transport = makeTransport(dir, { sidebandFails: true });
      const { sessionId, epoch, attachToken } = await transport.mintClientSecret('account-a');

      await assert.rejects(
        () => transport.attachCall('provider-call-1', sessionId, epoch, attachToken, 'account-a'),
        'a failing sideband must surface as an error',
      );

      assert.equal(transport.currentOwner, null, 'a failed attach must release the session slot');
      assert.equal(transport.status.state, 'failed');
    });
  });
});
