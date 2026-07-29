import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import {
  HermesSessionChatClient,
  VOICE_HERMES_MAX_ASSISTANT_BYTES,
  VOICE_HERMES_MAX_TRANSCRIPT_BYTES,
} from '../src/server/transports/voice/hermes-chat.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { FakeHermesAgent, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';

/**
 * Byte budgets must be counted in bytes.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a cap written as
 * `slice(0, N)` lets N non-ASCII characters weigh up to 3N bytes (4N with
 * astral characters) on the wire — the ceiling the provider and the sideband
 * are sized against is silently blown by any non-English content.
 *
 * The bounded content on this surface is no longer a context snapshot: it is
 * the operator's transcript on the way to Hermes, and Hermes' answer on the way
 * back. Neither may be truncated to fit. Half a question, or half an answer,
 * spoken with full confidence, is a fabrication — so anything over the bound is
 * refused and nothing is said.
 */

const MULTIBYTE = 'ありがとうございました。'; // 12 chars, 34 UTF-8 bytes
const CONTEXT: VoiceSessionContext = { sessionId: 'session-bounds', epoch: 1, leaseId: 'lease-bounds' };
const ROUTE = testVoiceConfig().hermes;

function clientReturning(body: unknown): HermesSessionChatClient {
  const fetchImpl = (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
  return new HermesSessionChatClient(ROUTE, { fetchImpl });
}

async function attach(hermes: FakeHermesAgent): Promise<FakeRealtimeSocket> {
  const sockets: FakeRealtimeSocket[] = [];
  const bridge = new RealtimeBridge(testVoiceConfig(), hermes, {
    accepts: () => true,
    userTurn: () => {},
    providerFailure: () => {},
    reportSpend: () => true,
  }, {
    websocketFactory: () => {
      const socket = new FakeRealtimeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  await bridge.attachSideband('call-bounds', CONTEXT);
  sockets[0].sent.length = 0;
  return sockets[0];
}

function transcriptEvent(itemId: string, transcript: string): string {
  return JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });
}

describe('hermes answer bounds — measured in UTF-8 bytes', () => {
  it('accepts a multibyte answer that fits the byte bound', async () => {
    // 34 bytes per repeat; comfortably inside the bound but far more code
    // units than a byte-count-shaped-as-slice cap would have allowed.
    const answer = MULTIBYTE.repeat(50);
    assert.ok(Buffer.byteLength(answer, 'utf8') <= VOICE_HERMES_MAX_ASSISTANT_BYTES);

    const result = await clientReturning({ content: answer })
      .send('hi', { signal: new AbortController().signal });

    assert.deepEqual(result, { kind: 'ok', assistantText: answer });
  });

  it('refuses a multibyte answer over the byte bound rather than truncating it', async () => {
    const answer = MULTIBYTE.repeat(150); // ~5 KB of UTF-8, over the bound
    assert.ok(Buffer.byteLength(answer, 'utf8') > VOICE_HERMES_MAX_ASSISTANT_BYTES);
    assert.ok(answer.length < VOICE_HERMES_MAX_ASSISTANT_BYTES, 'and under it by UTF-16 code units');

    const result = await clientReturning({ content: answer })
      .send('hi', { signal: new AbortController().signal });

    assert.equal(result.kind, 'error', 'half an answer must never be spoken as the whole answer');
  });
});

describe('transcript bounds — measured in UTF-8 bytes', () => {
  it('refuses an over-bound multibyte transcript without calling Hermes or speaking', async () => {
    const hermes = new FakeHermesAgent();
    const socket = await attach(hermes);
    const transcript = MULTIBYTE.repeat(150);
    assert.ok(Buffer.byteLength(transcript, 'utf8') > VOICE_HERMES_MAX_TRANSCRIPT_BYTES);
    assert.ok(transcript.length < VOICE_HERMES_MAX_TRANSCRIPT_BYTES, 'and under it by UTF-16 code units');

    socket.emit('message', transcriptEvent('item-over', transcript));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(hermes.sent, []);
    assert.deepEqual(socket.sentEvents(), []);
  });

  it('submits a multibyte transcript that fits, byte for byte, unaltered', async () => {
    const hermes = new FakeHermesAgent();
    const socket = await attach(hermes);
    const transcript = MULTIBYTE.repeat(50);

    socket.emit('message', transcriptEvent('item-ok', transcript));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(hermes.sent, [transcript], 'Hermes must receive exactly what was said');
  });
});

describe('rendered speech carries exactly the Hermes answer', () => {
  it('passes a multibyte answer through to the rendering response undamaged', async () => {
    const answer = MULTIBYTE.repeat(50);
    const hermes = new FakeHermesAgent({ reply: () => ({ kind: 'ok', assistantText: answer }) });
    const socket = await attach(hermes);

    socket.emit('message', transcriptEvent('item-1', 'hello'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const create = socket.sentEvents().find((event) => event.type === 'response.create');
    assert.ok(create, 'the answer must be rendered');
    const input = (create!.response as { input: Array<{ content: Array<{ text: string }> }> }).input;
    const spoken = input[0].content[0].text;

    assert.equal(spoken, answer, 'the spoken text is the Hermes answer verbatim');
    assert.equal(
      Buffer.from(spoken, 'utf8').toString('utf8'),
      spoken,
      'and it is still valid UTF-8',
    );
  });
});
