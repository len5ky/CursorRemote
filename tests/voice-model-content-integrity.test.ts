import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { FakeHermesAgent, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';

/**
 * Nothing may put words into the operator's ear that the operator did not say
 * and Hermes did not answer.
 *
 * The bridge used to carry an `announce()` helper that pushed a synthetic
 * `role: 'system'` message item and then asked the model to speak it. It had no
 * callers, but a live code path is one call site away, and a fabricated turn is
 * indistinguishable to the model from something real.
 *
 * The corrected surface has exactly one authored payload: an out-of-band
 * rendering response whose sole input is text Hermes actually returned. That
 * payload is not an exception to this rule, it is the subject of it — every
 * assertion below pins it to genuine Hermes content, out of band, with no
 * writes into the conversation the model can later build on.
 */

const root = join(import.meta.dirname, '..');
const CONTEXT: VoiceSessionContext = { sessionId: 'session-integrity', epoch: 1, leaseId: 'lease-integrity' };

function makeBridge(hermes = new FakeHermesAgent()) {
  const sockets: FakeRealtimeSocket[] = [];
  const bridge = new RealtimeBridge(testVoiceConfig(), hermes, {
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
  return { bridge, sockets, hermes };
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

  it('writes nothing into the provider conversation, whatever the provider says', async () => {
    const { bridge, sockets } = makeBridge();
    await bridge.attachSideband('provider-call-integrity', CONTEXT);
    const socket = sockets[0];

    // A realistic exchange: bring-up, speech, an audio commit, a completed
    // response. None of it authorises the relay to author a conversation item.
    socket.emit('message', JSON.stringify({ type: 'session.created', session: { model: 'gpt-realtime-2.1' } }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed' }));
    socket.emit('message', JSON.stringify({ type: 'response.done' }));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(
      socket.sentEvents().some((e) => e.type === 'conversation.item.create'),
      false,
      'the relay must never write an item into the provider conversation',
    );
  });

  it('speaks only Hermes text, out of band, and never as a conversation turn', async () => {
    const hermes = new FakeHermesAgent({ reply: () => ({ kind: 'ok', assistantText: 'hermes said this' }) });
    const { bridge, sockets } = makeBridge(hermes);
    await bridge.attachSideband('provider-call-integrity-hermes', CONTEXT);
    const socket = sockets[0];

    socket.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'what did you say',
    }));
    await new Promise((r) => setTimeout(r, 20));

    const creates = socket.sentEvents().filter((e) => e.type === 'response.create');
    assert.equal(creates.length, 1);
    const response = creates[0].response as Record<string, unknown>;

    // Out of band: the rendering never becomes context the model can build on.
    assert.equal(response.conversation, 'none');
    // And the only content is what Hermes returned, unchanged.
    assert.equal(
      JSON.stringify(response.input),
      JSON.stringify([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hermes said this' }] }]),
    );
    assert.equal(
      socket.sentEvents().some((e) => e.type === 'conversation.item.create'),
      false,
      'rendering must not write a turn into the conversation',
    );
  });

  it('asks for no speech at all when Hermes has said nothing', async () => {
    const { bridge, sockets } = makeBridge();
    await bridge.attachSideband('provider-call-integrity-2', CONTEXT);
    const socket = sockets[0];

    socket.emit('message', JSON.stringify({ type: 'session.created', session: { model: 'gpt-realtime-2.1' } }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed' }));
    socket.emit('message', JSON.stringify({ type: 'response.done' }));
    await new Promise((r) => setTimeout(r, 10));

    const types = socket.sentEvents().map((e) => e.type);
    assert.equal(
      types.includes('response.create'),
      false,
      'without a Hermes answer there is nothing to read, so the relay must not prompt speech',
    );
    assert.equal(types.includes('conversation.item.create'), false);
  });

  it('carries no proactive-notification scaffolding in the voice source', () => {
    // A static backstop for the runtime checks above: an unreferenced helper is
    // one import away from becoming a live injection path.
    for (const file of ['realtime-bridge.ts', 'index.ts', 'hermes-chat.ts', 'session.ts', 'text.ts']) {
      const source = readFileSync(join(root, 'src/server/transports/voice', file), 'utf8');
      assert.doesNotMatch(source, /proactive notification/i, `${file} carries proactive-announcement scaffolding`);
      assert.doesNotMatch(
        source,
        /role:\s*'(system|assistant)'|"role":\s*"(system|assistant)"/,
        `${file} authors a system or assistant turn`,
      );
    }

    // `input_text` exists in exactly one place — the out-of-band rendering
    // response — and it is built from validated Hermes text and nothing else.
    const bridge = readFileSync(join(root, 'src/server/transports/voice/realtime-bridge.ts'), 'utf8');
    const inputTextSites = bridge.match(/input_text/g) ?? [];
    assert.equal(inputTextSites.length, 1, 'there must be exactly one place that builds spoken content');
    assert.match(bridge, /text:\s*assistantText/, 'and it must carry the validated Hermes answer');

    for (const file of ['index.ts', 'hermes-chat.ts', 'session.ts', 'text.ts']) {
      const source = readFileSync(join(root, 'src/server/transports/voice', file), 'utf8');
      assert.doesNotMatch(source, /\binput_text\b/, `${file} builds message content for the model`);
    }
  });
});
