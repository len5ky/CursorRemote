import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import {
  FakeHermesAgent,
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
 * And a function-call envelope was answered with `conversation.item.create`.
 * The corrected surface declares no tools at all, so any function call is an
 * envelope this relay never solicited: the only defensible policy is to write
 * nothing to the provider conversation and end the session.
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
    const bridge = new RealtimeBridge(testVoiceConfig(), new FakeHermesAgent(), silentAuthority(record), {
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
    const bridge = new RealtimeBridge(testVoiceConfig(), new FakeHermesAgent(), silentAuthority(record), {
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
    const bridge = new RealtimeBridge(testVoiceConfig(), new FakeHermesAgent(), silentAuthority(record), {
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
      new FakeHermesAgent(),
      {
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith('/client_secrets')) {
            return new Response(JSON.stringify({ value: 'ephemeral-browser-secret', model: 'gpt-realtime-2.1' }), { status: 200 });
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

describe('provider tool call — refused outright, never answered', () => {
  const attached = async (record: { failures: string[] }) => {
    const socket = new FakeRealtimeSocket();
    const bridge = new RealtimeBridge(testVoiceConfig(), new FakeHermesAgent(), silentAuthority(record), {
      websocketFactory: () => socket as unknown as WebSocket,
    });
    await bridge.attachSideband('call-tooling', context());
    socket.sent.length = 0;
    return { socket, bridge };
  };

  /**
   * The session declares no tools and `tool_choice: 'none'`, so a function call
   * cannot legitimately arrive at all. There is no longer a well-formed variant
   * to answer: answering *any* of these would write a tool output for a tool
   * this surface does not have, on the authority of an envelope it never
   * solicited. Every shape below is a non-writing failure.
   */
  const envelopes: Array<[Record<string, unknown>, string]> = [
    [{ type: 'response.function_call_arguments.done', name: 'get_status', call_id: 'call-abc', arguments: '{}' }, 'a well-formed call'],
    [{ type: 'response.function_call_arguments.done', name: 'get_status', call_id: 'call-abc', arguments: '{not json' }, 'malformed arguments'],
    [{ type: 'response.function_call_arguments.done', name: 'x'.repeat(500), call_id: 'call-abc', arguments: '{}' }, 'an oversized name'],
    [{ type: 'response.function_call_arguments.done', name: 'get_status', call_id: 'c'.repeat(1_000), arguments: '{}' }, 'an oversized call id'],
    [{ type: 'response.function_call_arguments.done', name: '', call_id: '', arguments: '{}' }, 'an empty envelope'],
    [{ type: 'response.function_call_arguments.delta', name: 'get_status', call_id: 'call-abc', arguments: '{' }, 'a partial call'],
  ];

  for (const [event, label] of envelopes) {
    it(`writes nothing and ends the session for ${label}`, async () => {
      const record = { failures: [] as string[] };
      const { socket } = await attached(record);

      socket.emit('message', JSON.stringify(event));
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(socket.sentEvents(), [], `${label} must produce no provider write at all`);
      assert.equal(record.failures.length, 1, 'the session is terminated with a definite reason');
      assert.equal(record.failures[0], 'provider_tool_call_refused');
    });
  }
});
