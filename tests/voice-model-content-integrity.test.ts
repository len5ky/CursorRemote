import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import { VoiceToolRouter } from '../src/server/transports/voice/tools.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { FakeHermesConversationReader, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';

/**
 * Nothing may put words into the conversation that the user did not say and
 * the model did not produce.
 *
 * The bridge used to carry an `announce()` helper that pushed a synthetic
 * `role: 'system'` message item and then asked the model to speak it. It had no
 * callers, but a live code path is one call site away, and a fabricated turn is
 * indistinguishable to the model from something the user actually said. The
 * only conversation item the relay is allowed to create is the output of a tool
 * the model itself invoked.
 */

const root = join(import.meta.dirname, '..');
const CONTEXT: VoiceSessionContext = { sessionId: 'session-integrity', epoch: 1, leaseId: 'lease-integrity' };

function makeBridge() {
  const sockets: FakeRealtimeSocket[] = [];
  const router = new VoiceToolRouter(
    { contextReader: new FakeHermesConversationReader(), terminateVoice: async () => ({ state: 'terminated' }) },
    { accepts: () => true, live: () => true },
  );
  const bridge = new RealtimeBridge(testVoiceConfig(), router, {
    accepts: () => true,
    userTurn: () => {},
    providerFailure: () => {},
    reportSpend: () => true,
  }, {
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    websocketFactory: () => {
      const socket = new FakeRealtimeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { bridge, sockets };
}

describe('voice conversation integrity — no fabricated model content', () => {
  it('exposes no bridge method that injects a conversation turn', () => {
    const surface = [
      ...Object.getOwnPropertyNames(RealtimeBridge.prototype),
      ...Object.getOwnPropertyNames(makeBridge().bridge),
    ];

    for (const name of surface) {
      assert.doesNotMatch(
        name,
        /^(announce|say|speak|inject|notify|proactive|push(Message|Turn))/i,
        `RealtimeBridge.${name} looks like a content-injection entry point`,
      );
    }
  });

  it('creates only tool-call outputs on the sideband, never authored turns', async () => {
    const { bridge, sockets } = makeBridge();
    await bridge.attachSideband('provider-call-integrity', CONTEXT);
    const socket = sockets[0];

    // Drive a full realistic exchange: session bring-up, a user turn, a tool
    // call the model itself made, and a completed response.
    socket.emit('message', JSON.stringify({ type: 'session.created' }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed' }));
    socket.emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'read_context',
      call_id: 'call-1',
      arguments: '{}',
    }));
    await new Promise((r) => setTimeout(r, 10));
    socket.emit('message', JSON.stringify({ type: 'response.done' }));

    const created = socket.sentEvents().filter((e) => e.type === 'conversation.item.create');
    assert.ok(created.length > 0, 'the tool round-trip must have produced an item');

    for (const event of created) {
      const item = event.item as Record<string, unknown>;
      assert.equal(
        item.type,
        'function_call_output',
        `the relay created a ${String(item.type)} item; only outputs of model-invoked tools are allowed`,
      );
      assert.equal(item.role, undefined, 'a relay-created item must never carry a conversation role');
      assert.equal(item.content, undefined, 'a relay-created item must never carry authored content');
    }
  });

  it('asks for a response only after a tool the model itself invoked', async () => {
    const { bridge, sockets } = makeBridge();
    await bridge.attachSideband('provider-call-integrity-2', CONTEXT);
    const socket = sockets[0];

    socket.emit('message', JSON.stringify({ type: 'session.created' }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed' }));
    socket.emit('message', JSON.stringify({ type: 'response.done' }));
    await new Promise((r) => setTimeout(r, 10));

    const types = socket.sentEvents().map((e) => e.type);
    assert.equal(
      types.includes('response.create'),
      false,
      'without a tool call there is nothing for the relay to hand back, so it must not prompt speech',
    );
    assert.equal(types.includes('conversation.item.create'), false);
  });

  it('carries no proactive-notification scaffolding in the voice source', () => {
    // A static backstop for the runtime checks above: an unreferenced helper is
    // one import away from becoming a live injection path.
    for (const file of ['realtime-bridge.ts', 'index.ts', 'tools.ts', 'session.ts', 'context.ts']) {
      const source = readFileSync(join(root, 'src/server/transports/voice', file), 'utf8');
      assert.doesNotMatch(
        source,
        /proactive notification|role:\s*'(system|user|assistant)'|"role":\s*"(system|user|assistant)"/,
        `${file} authors a conversation turn`,
      );
      assert.doesNotMatch(source, /\binput_text\b/, `${file} builds message content for the model`);
    }
  });
});
