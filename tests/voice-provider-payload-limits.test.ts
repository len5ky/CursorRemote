import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientOptions } from 'ws';
import type WebSocket from 'ws';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import { VoiceToolRouter } from '../src/server/transports/voice/tools.js';
import {
  VOICE_MAX_PROVIDER_EVENT_BYTES,
  VOICE_MAX_PROVIDER_FRAME_BYTES,
} from '../src/server/transports/voice/constants.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { FakeHermesConversationReader, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';

/**
 * The sideband used a 16 KiB ws `maxPayload` while the application ignored
 * events over 32 KiB. The two limits contradicted each other: the application
 * bound was unreachable, and any provider event between the two sizes killed
 * the socket (ws closes on an oversize frame) which the bridge then reported
 * as a provider failure and terminated the call. Oversize provider input is a
 * bounded-parse concern, not a reason to drop a live call.
 */

const CONTEXT: VoiceSessionContext = { sessionId: 'session-limits', epoch: 1, leaseId: 'lease-limits' };

function makeBridge(options: { onProviderFailure?: (reason: string) => void } = {}) {
  const captured: { options: ClientOptions | null } = { options: null };
  const sockets: FakeRealtimeSocket[] = [];
  const router = new VoiceToolRouter(
    { contextReader: new FakeHermesConversationReader(), terminateVoice: async () => ({ state: 'terminated' }) },
    { accepts: () => true, live: () => true },
  );
  const bridge = new RealtimeBridge(testVoiceConfig(), router, {
    accepts: () => true,
    userTurn: () => {},
    providerFailure: (_context, reason) => { options.onProviderFailure?.(reason); },
    reportSpend: () => true,
  }, {
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    websocketFactory: (_url: string, wsOptions: ClientOptions) => {
      captured.options = wsOptions;
      const socket = new FakeRealtimeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { bridge, captured, sockets };
}

describe('voice provider payload limits — alignment', () => {
  it('keeps the frame ceiling above the parse limit so oversize input is refusable, not fatal', () => {
    assert.ok(
      VOICE_MAX_PROVIDER_FRAME_BYTES > VOICE_MAX_PROVIDER_EVENT_BYTES,
      'the ws frame ceiling must leave headroom above the application parse limit',
    );
  });

  it('opens the sideband with the aligned frame ceiling as maxPayload', async () => {
    const { bridge, captured } = makeBridge();
    await bridge.attachSideband('provider-call-limits', CONTEXT);
    assert.equal(captured.options?.maxPayload, VOICE_MAX_PROVIDER_FRAME_BYTES);
    bridge.detach();
  });
});

describe('voice provider payload limits — oversize input is non-fatal', () => {
  it('drops an oversize provider event without failing the session or the sideband', async () => {
    const failures: string[] = [];
    const { bridge, captured, sockets } = makeBridge({ onProviderFailure: (reason) => failures.push(reason) });
    await bridge.attachSideband('provider-call-limits', CONTEXT);
    const socket = sockets[0];

    const oversize = JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'get_status',
      call_id: 'fc-oversize',
      arguments: '{}',
      padding: 'x'.repeat(VOICE_MAX_PROVIDER_EVENT_BYTES + 1),
    });
    assert.ok(Buffer.byteLength(oversize) > VOICE_MAX_PROVIDER_EVENT_BYTES);
    assert.ok(
      Buffer.byteLength(oversize) < VOICE_MAX_PROVIDER_FRAME_BYTES * 4,
      'the fixture stays in the range a real provider event could plausibly occupy',
    );

    socket.emit('message', Buffer.from(oversize));
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(failures, [], 'an oversize event must not be reported as a provider failure');
    assert.equal(socket.readyState, 1, 'the sideband must stay open');
    assert.equal(
      socket.sentEvents().some((e) => (e.item as { call_id?: string } | undefined)?.call_id === 'fc-oversize'),
      false,
      'the oversize event must not be acted on',
    );

    // The session keeps working: a well-sized event still gets answered.
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'get_status',
      call_id: 'fc-ok',
      arguments: '{}',
    })));
    await new Promise((r) => setTimeout(r, 20));

    const answered = socket.sentEvents()
      .map((e) => e.item as { call_id?: string } | undefined)
      .some((item) => item?.call_id === 'fc-ok');
    assert.equal(answered, true, 'the sideband still answers after an oversize event');
    assert.equal(captured.options?.maxPayload, VOICE_MAX_PROVIDER_FRAME_BYTES);

    bridge.detach();
  });
});
