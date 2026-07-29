import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { RealtimeBridge, buildSessionConfig } from '../src/server/transports/voice/realtime-bridge.js';
import { VOICE_REALTIME_MODEL, VOICE_TRANSCRIPTION_MODEL } from '../src/server/transports/voice/constants.js';
import { VOICE_HERMES_MAX_TRANSCRIPT_BYTES } from '../src/server/transports/voice/hermes-chat.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { FakeHermesAgent, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';

/**
 * The corrected core product: the Realtime model is ears and mouth only.
 *
 * A final input-audio transcript is the single trigger. The relay sends that
 * transcript server-to-server to Hermes, and the only thing the provider is
 * ever asked to speak is an out-of-band rendering of Hermes' own words.
 */

const root = join(import.meta.dirname, '..');
const CONTEXT: VoiceSessionContext = { sessionId: 'session-turn', epoch: 1, leaseId: 'lease-turn' };

interface Harness {
  bridge: RealtimeBridge;
  socket: FakeRealtimeSocket;
  hermes: FakeHermesAgent;
  failures: string[];
  turns: number;
}

async function attach(hermes = new FakeHermesAgent()): Promise<Harness> {
  const sockets: FakeRealtimeSocket[] = [];
  const failures: string[] = [];
  const harness = { hermes, failures, turns: 0 } as Harness;
  const bridge = new RealtimeBridge(testVoiceConfig(), hermes, {
    accepts: () => true,
    userTurn: () => { harness.turns += 1; },
    providerFailure: (_context, reason) => { failures.push(reason); },
    reportSpend: () => true,
  }, {
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    websocketFactory: () => {
      const socket = new FakeRealtimeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  await bridge.attachSideband('provider-call-turn', CONTEXT);
  harness.bridge = bridge;
  harness.socket = sockets[0];
  return harness;
}

function transcriptCompleted(itemId: string, transcript: unknown): string {
  return JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });
}

const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function responseCreates(socket: FakeRealtimeSocket): Array<Record<string, unknown>> {
  return socket.sentEvents()
    .filter((event) => event.type === 'response.create')
    .map((event) => event.response as Record<string, unknown>);
}

describe('realtime session config — ears and mouth only', () => {
  it('pins the model, enables input transcription, and disables every automatic answer', () => {
    const session = buildSessionConfig(testVoiceConfig()).session as Record<string, any>;

    assert.equal(session.model, VOICE_REALTIME_MODEL);
    assert.equal(session.model, 'gpt-realtime-2.1');

    // Transcription is what produces the only trigger this surface has.
    assert.equal(session.audio.input.transcription.model, VOICE_TRANSCRIPTION_MODEL);

    // Server VAD segments speech; it must never author a response, and it must
    // never interrupt on its own — the relay owns turn cancellation.
    assert.equal(session.audio.input.turn_detection.type, 'server_vad');
    assert.equal(session.audio.input.turn_detection.create_response, false);
    assert.equal(session.audio.input.turn_detection.interrupt_response, false);

    // No conversational tools at all, and nothing to choose.
    assert.deepEqual(session.tools, []);
    assert.equal(session.tool_choice, 'none');
  });

  it('re-asserts that same config on the sideband when the session is created', async () => {
    const { socket } = await attach();
    socket.emit('message', JSON.stringify({ type: 'session.created', session: { model: 'gpt-realtime-2.1' } }));
    await settle();

    const update = socket.sentEvents().find((event) => event.type === 'session.update');
    assert.ok(update, 'the relay must re-assert its session config');
    const session = update!.session as Record<string, any>;
    assert.deepEqual(session.tools, []);
    assert.equal(session.tool_choice, 'none');
    assert.equal(session.model, 'gpt-realtime-2.1');
  });

  it('leaves response creation and response instructions entirely to the server', () => {
    const client = readFileSync(join(root, 'src/client/voice.js'), 'utf8');
    assert.doesNotMatch(client, /response\.create/, 'the browser must never create a provider response');
    // Not a mention of the word — an actual assignment. The browser must never
    // set response instructions, only the relay may.
    assert.doesNotMatch(client, /instructions\s*[:=]/, 'the browser must never own response instructions');
    assert.doesNotMatch(client, /conversation\.item\.create/, 'the browser must never author conversation items');
  });

  it('declares no conversational tool schema anywhere in the voice source', () => {
    for (const file of ['realtime-bridge.ts', 'index.ts', 'constants.ts', 'session.ts', 'hermes-chat.ts']) {
      const source = readFileSync(join(root, 'src/server/transports/voice', file), 'utf8');
      assert.doesNotMatch(source, /type:\s*'function'|"type":\s*"function"/, `${file} declares a provider tool`);
      assert.doesNotMatch(source, /tool_choice:\s*'(auto|required)'/, `${file} lets the provider choose a tool`);
    }
  });
});

describe('final transcript is the only trigger', () => {
  it('sends the actual transcript to Hermes on a completed transcription', async () => {
    const { socket, hermes, turns } = await attach();
    void turns;
    socket.emit('message', transcriptCompleted('item-1', ' where are we up to '));
    await settle();

    assert.deepEqual(hermes.sent, ['where are we up to']);
  });

  it('does not trigger on an audio commit or a speech-started event', async () => {
    const harness = await attach();
    harness.socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item-1' }));
    harness.socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    harness.socket.emit('message', JSON.stringify({ type: 'conversation.item.created', item: { id: 'item-1' } }));
    await settle();

    assert.deepEqual(harness.hermes.sent, [], 'only a completed transcript may reach Hermes');
    assert.ok(harness.turns >= 1, 'an audio commit still counts as user activity for idleness');
  });

  it('dedupes a repeated transcript event by item id', async () => {
    const { socket, hermes } = await attach();
    socket.emit('message', transcriptCompleted('item-1', 'hello there'));
    await settle();
    socket.emit('message', transcriptCompleted('item-1', 'hello there'));
    socket.emit('message', transcriptCompleted('item-1', 'a different replay'));
    await settle();

    assert.deepEqual(hermes.sent, ['hello there'], 'one item id is one Hermes turn');
  });

  it('refuses an empty, malformed or over-bound transcript without calling Hermes', async () => {
    const { socket, hermes } = await attach();
    const bad: unknown[] = ['', '   ', 42, null, undefined, { text: 'hi' }, 'あ'.repeat(VOICE_HERMES_MAX_TRANSCRIPT_BYTES)];
    bad.forEach((value, index) => socket.emit('message', transcriptCompleted(`bad-${index}`, value)));
    await settle();

    assert.deepEqual(hermes.sent, []);
    assert.deepEqual(responseCreates(socket), [], 'a refused transcript must not produce speech');
  });

  it('refuses a transcript event with a missing or over-long item id', async () => {
    const { socket, hermes } = await attach();
    socket.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'no item id',
    }));
    socket.emit('message', transcriptCompleted('x'.repeat(1_024), 'over-long item id'));
    await settle();

    assert.deepEqual(hermes.sent, []);
  });
});

describe('hermes text is the only thing the provider ever speaks', () => {
  it('injects an out-of-band audio-only rendering response carrying the Hermes answer', async () => {
    const hermes = new FakeHermesAgent({ reply: () => ({ kind: 'ok', assistantText: 'the migration finished an hour ago' }) });
    const { socket } = await attach(hermes);

    socket.emit('message', transcriptCompleted('item-1', 'where are we up to'));
    await settle();

    const creates = responseCreates(socket);
    assert.equal(creates.length, 1, 'exactly one rendering response per Hermes answer');
    const response = creates[0];

    assert.equal(response.conversation, 'none', 'rendering must stay out of band');
    assert.deepEqual(response.output_modalities, ['audio'], 'audio only');
    assert.deepEqual(response.input, [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'the migration finished an hour ago' }],
    }], 'the explicit custom input is the validated Hermes text, verbatim');
    assert.match(String(response.instructions), /verbatim/i);
    assert.match(String(response.instructions), /only/i);

    const metadata = response.metadata as Record<string, unknown>;
    assert.equal(metadata.source, 'hermes');
    assert.equal(metadata.turn_id, '1');
    // Turn/source metadata must not smuggle Hermes identity to the provider.
    assert.doesNotMatch(JSON.stringify(metadata), /hermes-session-configured|hermes-session-key-for-test/);
  });

  it('creates no conversation item and no response when Hermes fails', async () => {
    const hermes = new FakeHermesAgent({ reply: () => ({ kind: 'error', reason: 'hermes_unavailable' }) });
    const { socket } = await attach(hermes);

    socket.emit('message', transcriptCompleted('item-1', 'anything'));
    await settle();

    const types = socket.sentEvents().map((event) => event.type);
    assert.equal(types.includes('response.create'), false, 'there is no local or synthetic fallback answer');
    assert.equal(types.includes('conversation.item.create'), false);
  });

  it('carries no fallback, canned or deterministic answer anywhere in the voice source', () => {
    for (const file of ['realtime-bridge.ts', 'index.ts', 'hermes-chat.ts', 'constants.ts']) {
      const source = readFileSync(join(root, 'src/server/transports/voice', file), 'utf8');
      assert.doesNotMatch(
        source,
        /fallbackAnswer|cannedAnswer|defaultAssistantText|synthesizeAnswer|assistantText\s*=\s*['"][^'"]{4,}/,
        `${file} ships a substitute for a Hermes answer`,
      );
    }
  });

  it('refuses a provider function call outright — there is no tool path left', async () => {
    const { socket, failures, hermes } = await attach();
    socket.emit('message', JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'get_status',
      call_id: 'fc-1',
      arguments: '{}',
    }));
    await settle();

    assert.deepEqual(hermes.sent, []);
    assert.equal(
      socket.sentEvents().some((event) => event.type === 'conversation.item.create'),
      false,
      'a tool call the session never offered gets no output, only a refusal',
    );
    assert.equal(failures.includes('provider_tool_call_refused'), true);
  });
});

describe('turn semantics — no late answer may be spoken', () => {
  it('assigns monotonic turn ids and aborts the outstanding Hermes fetch on new speech', async () => {
    const hermes = new FakeHermesAgent({
      delayMs: (index) => (index === 0 ? 60 : 0),
      reply: (_transcript, index) => ({ kind: 'ok', assistantText: `answer ${index + 1}` }),
    });
    const { socket } = await attach(hermes);

    socket.emit('message', transcriptCompleted('item-1', 'first question'));
    await settle(5);
    socket.emit('message', transcriptCompleted('item-2', 'second question'));
    await settle(120);

    assert.deepEqual(hermes.sent, ['first question', 'second question']);
    assert.equal(hermes.signals[0].aborted, true, 'the superseded turn must be aborted');
    assert.equal(hermes.signals[1].aborted, false);

    const creates = responseCreates(socket);
    assert.equal(creates.length, 1, 'only the current turn may be rendered');
    assert.equal(
      JSON.stringify(creates[0].input).includes('answer 1'),
      false,
      'the late answer to a superseded question must never be spoken',
    );
    assert.equal((creates[0].metadata as Record<string, unknown>).turn_id, '2');
  });

  it('cancels a stale speaking response before the next turn is rendered', async () => {
    const hermes = new FakeHermesAgent();
    const { socket } = await attach(hermes);

    socket.emit('message', transcriptCompleted('item-1', 'first question'));
    await settle();
    // The provider acknowledges the rendering response it is now speaking.
    socket.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-1', metadata: { source: 'hermes', turn_id: '1' } },
    }));
    await settle();

    socket.emit('message', transcriptCompleted('item-2', 'second question'));
    await settle();

    const cancels = socket.sentEvents().filter((event) => event.type === 'response.cancel');
    assert.equal(cancels.length, 1, 'the stale speaking response must be cancelled exactly once');
    assert.equal(cancels[0].response_id, 'resp-1');
  });

  it('fails closed on an untagged response.created instead of leaving audio silently playable', async () => {
    const { socket, failures } = await attach();

    socket.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-untagged' },
    }));
    await settle();

    assert.deepEqual(
      socket.sentEvents().filter((event) => event.type === 'response.cancel'),
      [{ type: 'response.cancel', response_id: 'resp-untagged' }],
      'an untrusted response must be cancelled before it can remain playable',
    );
    assert.deepEqual(failures, ['provider_response_untrusted']);
  });

  it('fails closed on a stale or malformed response.created, without stealing a live id', async () => {
    const { socket, failures } = await attach();

    socket.emit('message', transcriptCompleted('item-1', 'first question'));
    await settle();
    socket.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-1', metadata: { source: 'hermes', turn_id: '1' } },
    }));
    await settle();

    // A response tagged for a turn that is not the one the relay is waiting on,
    // and one whose id is unusable, arrive while turn 1 is legitimately being
    // spoken. Both are untrusted.
    socket.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-stale', metadata: { source: 'hermes', turn_id: '99' } },
    }));
    socket.emit('message', JSON.stringify({
      type: 'response.created',
      response: { metadata: { source: 'hermes', turn_id: '1' } },
    }));
    await settle();

    assert.deepEqual(
      socket.sentEvents().filter((event) => event.type === 'response.cancel'),
      [
        { type: 'response.cancel', response_id: 'resp-stale' },
        // No provider id to name: the generic cancel targets the response in
        // progress rather than guessing at an id.
        { type: 'response.cancel' },
      ],
    );
    assert.deepEqual(failures, ['provider_response_untrusted', 'provider_response_untrusted']);

    // The genuine rendering was never displaced by an untrusted id: barge-in
    // still cancels resp-1, not resp-stale.
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await settle();
    const cancels = socket.sentEvents().filter((event) => event.type === 'response.cancel');
    assert.deepEqual(cancels[cancels.length - 1], { type: 'response.cancel', response_id: 'resp-1' });
  });

  it('discards a Hermes result that lands after the sideband is gone', async () => {
    const hermes = new FakeHermesAgent({ delayMs: () => 40 });
    const { bridge, socket } = await attach(hermes);

    socket.emit('message', transcriptCompleted('item-1', 'question'));
    await settle(5);
    bridge.detach(CONTEXT);
    await settle(80);

    assert.deepEqual(responseCreates(socket), [], 'a detached call speaks nothing');
  });
});

describe('barge-in — the operator speaking ends the turn, server-side', () => {
  /**
   * Regression: barge-in has to be decided by the relay, not the browser.
   *
   * The browser can send `response.cancel` for audio it can hear, and it does —
   * but that is a courtesy, not a boundary. It has no idea a Hermes fetch is in
   * flight, cannot abort it, and would let the answer to a question the
   * operator has already abandoned arrive late and be spoken over them. Server
   * VAD is also configured with `interrupt_response: false`, so the provider
   * will not stop itself either. The relay owns the turn, so the relay ends it.
   */

  it('aborts an in-flight Hermes fetch and never speaks its late answer', async () => {
    const hermes = new FakeHermesAgent({ delayMs: () => 60 });
    const { socket } = await attach(hermes);

    socket.emit('message', transcriptCompleted('item-1', 'the abandoned question'));
    await settle(5);
    assert.deepEqual(hermes.sent, ['the abandoned question'], 'the turn is genuinely in flight');

    // The operator starts talking again before Hermes has answered.
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    assert.equal(hermes.signals[0].aborted, true, 'the relay must abort its own fetch immediately');

    // Let the abandoned fetch resolve well past the barge-in.
    await settle(120);

    assert.deepEqual(responseCreates(socket), [], 'a late answer to an abandoned question is never spoken');
    assert.deepEqual(hermes.sent, ['the abandoned question'], 'and speech starting is never itself a Hermes turn');
  });

  it('cancels the Hermes rendering response the provider is speaking, by id', async () => {
    const hermes = new FakeHermesAgent();
    const { socket } = await attach(hermes);

    socket.emit('message', transcriptCompleted('item-1', 'first question'));
    await settle();
    socket.emit('message', JSON.stringify({
      type: 'response.created',
      response: { id: 'resp-render-1', metadata: { source: 'hermes', turn_id: '1' } },
    }));
    await settle();

    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await settle();

    const cancels = socket.sentEvents().filter((event) => event.type === 'response.cancel');
    assert.equal(cancels.length, 1, 'the response being spoken must be cancelled exactly once');
    assert.equal(cancels[0].response_id, 'resp-render-1', 'and cancelled by id, not blindly');

    // The cancel is not repeated when the same barge-in is re-signalled, so a
    // stale id can never land on some later response.
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await settle();
    assert.equal(socket.sentEvents().filter((event) => event.type === 'response.cancel').length, 1);
  });

  it('cancels nothing and asks nothing when there is no turn to interrupt', async () => {
    const { socket, hermes } = await attach();

    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item-1' }));
    await settle();

    assert.deepEqual(socket.sentEvents(), [], 'an idle barge-in is not a provider write');
    assert.deepEqual(hermes.sent, [], 'and neither event is ever a Hermes trigger');
  });

  it('still answers the question the operator actually finished asking', async () => {
    const hermes = new FakeHermesAgent({
      delayMs: (index) => (index === 0 ? 60 : 0),
      reply: (_transcript, index) => ({ kind: 'ok', assistantText: `answer ${index + 1}` }),
    });
    const { socket } = await attach(hermes);

    // Question one is abandoned mid-fetch by the operator speaking again...
    socket.emit('message', transcriptCompleted('item-1', 'first question'));
    await settle(5);
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    // ...and question two runs to completion normally.
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item-2' }));
    socket.emit('message', transcriptCompleted('item-2', 'second question'));
    await settle(120);

    const creates = responseCreates(socket);
    assert.equal(creates.length, 1, 'exactly one answer is spoken');
    assert.match(JSON.stringify(creates[0].input), /answer 2/);
    assert.doesNotMatch(JSON.stringify(creates[0].input), /answer 1/);
    assert.equal((creates[0].metadata as Record<string, unknown>).turn_id, '2', 'turn ids stay monotonic');
  });
});
