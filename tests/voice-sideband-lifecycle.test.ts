import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import { VoiceToolRouter } from '../src/server/transports/voice/tools.js';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { VOICE_MAX_TOOL_ARGUMENT_BYTES } from '../src/server/transports/voice/constants.js';
import {
  FakeHermesConversationReader,
  FakeRealtimeSocket,
  testVoiceConfig,
} from './helpers/voice-fixtures.js';

/**
 * Two sideband failure modes that left the surface in a state nobody could act
 * on.
 *
 * A provider socket that is closed *before* it ever opens settled nothing: the
 * attach promise sat pending until the 15-second connect timer, so
 * `POST /api/voice/call` held an HTTP request open for fifteen seconds over a
 * connection that was already gone, while the session it had just activated
 * stayed activated.
 *
 * And an oversized function-call envelope was answered with
 * `conversation.item.create`. That envelope is untrusted by definition — its
 * `call_id` may be truncated or forged and its arguments were never parsed — so
 * the only defensible policy is to write nothing at all to the provider
 * conversation and end the session.
 */

const context = (): VoiceSessionContext => ({ sessionId: 'session-1', epoch: 1, leaseId: 'lease-1' });

function silentAuthority(record: { failures: string[] }) {
  return {
    accepts: () => true,
    userTurn: () => {},
    providerFailure: (_context: VoiceSessionContext, reason: string) => { record.failures.push(reason); },
    reportSpend: () => true,
  };
}

describe('sideband attach — a close before open settles the attach', () => {
  it('rejects the attach promise instead of leaving it pending', async () => {
    const record = { failures: [] as string[] };
    const socket = new FakeRealtimeSocket(false);
    const bridge = new RealtimeBridge(testVoiceConfig(), {} as VoiceToolRouter, silentAuthority(record), {
      websocketFactory: () => socket as unknown as WebSocket,
    });

    let settled = 'pending';
    const attach = bridge.attachSideband('call-preopen', context());
    void attach.then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });

    socket.close();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(settled, 'rejected', 'a pre-open close must settle the attach immediately');
    await assert.rejects(attach);
  });

  it('releases the socket but keeps the call id so the provider call can still be hung up', async () => {
    const record = { failures: [] as string[] };
    const socket = new FakeRealtimeSocket(false);
    const bridge = new RealtimeBridge(testVoiceConfig(), {} as VoiceToolRouter, silentAuthority(record), {
      websocketFactory: () => socket as unknown as WebSocket,
    });

    const attach = bridge.attachSideband('call-preopen', context());
    socket.close();
    await assert.rejects(attach);

    assert.equal(bridge.connected, false, 'the dead socket is no longer owned');
    assert.equal(
      bridge.detach(context()),
      'call-preopen',
      'the provider call id survives so termination can still hang it up',
    );
  });

  it('reports the provider failure once, not once per close and error', async () => {
    const record = { failures: [] as string[] };
    const socket = new FakeRealtimeSocket(false);
    const bridge = new RealtimeBridge(testVoiceConfig(), {} as VoiceToolRouter, silentAuthority(record), {
      websocketFactory: () => socket as unknown as WebSocket,
    });

    const attach = bridge.attachSideband('call-preopen', context());
    socket.close();
    await assert.rejects(attach);
    socket.emit('close');

    assert.equal(record.failures.length, 1, `a single dead socket is a single failure, saw ${record.failures.join(', ')}`);
  });
});

describe('voice transport — close-only attach lifecycle', () => {
  it('does not leave an activated orphan session behind', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'voice-sideband-lifecycle-'));
    const hangups: string[] = [];
    const transport = new VoiceTransport(
      testVoiceConfig(),
      dataDir,
      new FakeHermesConversationReader(),
      {
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/client_secrets')) {
            return new Response(JSON.stringify({ value: 'ephemeral-browser-secret' }), { status: 200 });
          }
          if (url.includes('/hangup')) { hangups.push(url); return new Response(null, { status: 200 }); }
          throw new Error(`unexpected provider call: ${url}`);
        }) as typeof fetch,
        websocketFactory: () => {
          const socket = new FakeRealtimeSocket(false);
          // The provider drops the connection as soon as it is created.
          queueMicrotask(() => socket.close());
          return socket as unknown as WebSocket;
        },
      },
    );

    try {
      const minted = await transport.mintClientSecret('owner-a');
      await assert.rejects(
        transport.attachCall('call-preopen', minted.sessionId, minted.epoch, minted.attachToken, 'owner-a'),
        'the attach must fail rather than hang',
      );

      const status = transport.status;
      assert.ok(
        status.state === 'terminated' || status.state === 'failed',
        `the session must not stay active after a dead sideband, saw ${status.state}`,
      );
      assert.equal(status.connected, false);
      assert.ok(hangups.length > 0, 'the provider call is hung up rather than orphaned');
    } finally {
      await transport.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('provider tool envelope — oversized input is a non-writing failure', () => {
  const attached = async (record: { failures: string[] }) => {
    const socket = new FakeRealtimeSocket();
    const bridge = new RealtimeBridge(testVoiceConfig(), {} as VoiceToolRouter, silentAuthority(record), {
      websocketFactory: () => socket as unknown as WebSocket,
    });
    await bridge.attachSideband('call-oversize', context());
    socket.sent.length = 0;
    return { socket, bridge };
  };

  it('writes no conversation item for an oversized argument blob and ends the session', async () => {
    const record = { failures: [] as string[] };
    const { socket } = await attached(record);

    socket.emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'get_status',
      call_id: 'call-abc',
      arguments: JSON.stringify({ padding: 'x'.repeat(VOICE_MAX_TOOL_ARGUMENT_BYTES + 500) }),
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(socket.sentEvents(), [], 'an untrusted envelope must produce no provider write at all');
    assert.equal(record.failures.length, 1, 'the session is terminated with a definite reason');
    assert.match(record.failures[0], /tool_envelope/);
  });

  it('writes no conversation item for an oversized call id or function name', async () => {
    for (const event of [
      { type: 'response.function_call_arguments.done', name: 'x'.repeat(500), call_id: 'call-abc', arguments: '{}' },
      { type: 'response.function_call_arguments.done', name: 'get_status', call_id: 'c'.repeat(1_000), arguments: '{}' },
      { type: 'response.function_call_arguments.done', name: '', call_id: 'call-abc', arguments: '{}' },
      { type: 'response.function_call_arguments.done', name: 'get_status', call_id: '', arguments: '{}' },
    ]) {
      const record = { failures: [] as string[] };
      const { socket } = await attached(record);

      socket.emit('message', JSON.stringify(event));
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(
        socket.sentEvents(),
        [],
        `an envelope with name "${String(event.name).slice(0, 12)}" must not be answered`,
      );
      assert.equal(record.failures.length, 1);
    }
  });

  it('still answers a well-formed call whose arguments are merely malformed', async () => {
    const record = { failures: [] as string[] };
    const socket = new FakeRealtimeSocket();
    const bridge = new RealtimeBridge(
      testVoiceConfig(),
      new VoiceToolRouter({ contextReader: new FakeHermesConversationReader() }),
      silentAuthority(record),
      { websocketFactory: () => socket as unknown as WebSocket },
    );
    await bridge.attachSideband('call-malformed', context());
    socket.sent.length = 0;

    socket.emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'get_status',
      call_id: 'call-abc',
      arguments: '{not json',
    }));
    await new Promise((resolve) => setImmediate(resolve));

    const types = socket.sentEvents().map((event) => event.type);
    assert.ok(
      types.includes('conversation.item.create'),
      'a bounded, well-formed tool call still gets its answer so the model is not left waiting',
    );
    assert.equal(record.failures.length, 0, 'a recoverable argument error does not end the call');
  });
});
