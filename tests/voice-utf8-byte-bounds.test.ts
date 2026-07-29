import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import {
  HermesSessionChatClient,
  VOICE_HERMES_MAX_ASSISTANT_BYTES,
  VOICE_HERMES_MAX_SESSION_ID_BYTES,
  VOICE_HERMES_MAX_TRANSCRIPT_BYTES,
  normalizeVoiceTranscript,
} from '../src/server/transports/voice/hermes-chat.js';
import { VOICE_MAX_ITEM_ID_BYTES } from '../src/server/transports/voice/constants.js';
import { truncateUtf8 } from '../src/server/transports/voice/text.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { FakeHermesAgent, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';
import { startVoiceRelay } from './helpers/voice-relay-harness.js';

/**
 * Every declared cap on this surface is a *byte* cap, and has to be enforced in
 * bytes.
 *
 * `String.prototype.slice` counts UTF-16 code units. A field capped with
 * `slice(0, N)` therefore passes through up to 3N bytes of BMP text (4N with
 * astral characters), so a Japanese question, a Hermes answer with an emoji, or
 * a provider item id written in anything but English silently blows the ceiling
 * the sideband frame and the Hermes request are sized against. Where a value
 * *is* cut, the cut has to land on a character boundary: a value ending in half
 * a code point is neither valid UTF-8 nor something the model can read back.
 *
 * The two values that carry meaning — the operator's transcript and Hermes'
 * answer — are never cut at all. Over the bound is refused, because half a
 * question or half an answer spoken as the whole thing is a fabrication.
 */

const CONTEXT: VoiceSessionContext = { sessionId: 'session-utf8', epoch: 1, leaseId: 'lease-utf8' };

/** 'あ' is three UTF-8 bytes and one UTF-16 code unit — the whole problem in one character. */
const WIDE = 'あ';
/** '𝔘' is four UTF-8 bytes and *two* UTF-16 code units. */
const ASTRAL = '\u{1D518}';

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** True when the string survives a UTF-8 round trip, i.e. holds no broken code point. */
function isValidUtf8(value: string): boolean {
  return !value.includes('\ufffd') && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function assertBounded(label: string, value: string, maxBytes: number): void {
  assert.ok(
    byteLength(value) <= maxBytes,
    `${label} must be capped in bytes: got ${byteLength(value)} bytes for a ${maxBytes}-byte cap`,
  );
  assert.ok(isValidUtf8(value), `${label} must remain valid UTF-8 after truncation`);
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
  await bridge.attachSideband('call-utf8', CONTEXT);
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

function hermesReturning(body: unknown): HermesSessionChatClient {
  const fetchImpl = (async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
  return new HermesSessionChatClient(testVoiceConfig().hermes, { fetchImpl });
}

describe('voice UTF-8 byte bounds — the shared truncation helper', () => {
  it('cuts by bytes, never by code units', () => {
    const value = WIDE.repeat(10); // 30 bytes, 10 code units
    assert.equal(byteLength(truncateUtf8(value, 30)), 30, 'a value exactly at its cap is untouched');
    assert.equal(truncateUtf8(value, 30), value);
    assertBounded('wide truncation', truncateUtf8(value, 29), 29);
    assert.equal(truncateUtf8(value, 29), WIDE.repeat(9), 'the partial character is dropped, not split');
  });

  it('cuts astral characters on a code-point boundary', () => {
    const value = ASTRAL.repeat(4); // 16 bytes, 8 code units
    for (const cap of [15, 14, 13]) {
      const cut = truncateUtf8(value, cap);
      assertBounded(`astral truncation at ${cap}`, cut, cap);
      assert.equal(cut, ASTRAL.repeat(3), 'half a surrogate pair is never emitted');
    }
    assert.equal(truncateUtf8(value, 0), '');
  });
});

describe('voice UTF-8 byte bounds — the transcript is refused, never trimmed', () => {
  it('refuses a transcript over the byte cap that is under the code-unit count', async () => {
    // Under the cap counted in UTF-16 code units, well over it in bytes: the
    // exact shape a `slice`-based cap would have let straight through.
    const transcript = WIDE.repeat(VOICE_HERMES_MAX_TRANSCRIPT_BYTES - 1);
    assert.ok(transcript.length < VOICE_HERMES_MAX_TRANSCRIPT_BYTES);
    assert.ok(byteLength(transcript) > VOICE_HERMES_MAX_TRANSCRIPT_BYTES);

    assert.equal(normalizeVoiceTranscript(transcript).ok, false);

    const hermes = new FakeHermesAgent();
    const socket = await attach(hermes);
    socket.emit('message', transcriptEvent('item-over', transcript));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(hermes.sent, [], 'no truncated question may be asked');
    assert.deepEqual(socket.sentEvents(), [], 'and nothing may be spoken about it');
  });

  it('accepts a transcript exactly at the byte cap, unaltered', async () => {
    const transcript = 'a'.repeat(VOICE_HERMES_MAX_TRANSCRIPT_BYTES);
    const hermes = new FakeHermesAgent();
    const socket = await attach(hermes);

    socket.emit('message', transcriptEvent('item-at-cap', transcript));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(hermes.sent, [transcript]);
  });

  it('bounds the provider item id by bytes, not by code units', async () => {
    const hermes = new FakeHermesAgent();
    const socket = await attach(hermes);

    // Under the cap in code units, over it in bytes.
    const itemId = WIDE.repeat(VOICE_MAX_ITEM_ID_BYTES - 1);
    assert.ok(itemId.length < VOICE_MAX_ITEM_ID_BYTES);
    assert.ok(byteLength(itemId) > VOICE_MAX_ITEM_ID_BYTES);

    socket.emit('message', transcriptEvent(itemId, 'a perfectly good question'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(hermes.sent, [], 'an unbounded turn key must not be trusted for dedupe');

    // A multibyte id that genuinely fits is still usable.
    const fits = WIDE.repeat(10);
    socket.emit('message', transcriptEvent(fits, 'a perfectly good question'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(hermes.sent, ['a perfectly good question']);
  });
});

describe('voice UTF-8 byte bounds — the Hermes answer is refused, never trimmed', () => {
  it('refuses an answer over the byte cap that is under the code-unit count', async () => {
    const answer = WIDE.repeat(VOICE_HERMES_MAX_ASSISTANT_BYTES - 1);
    assert.ok(answer.length < VOICE_HERMES_MAX_ASSISTANT_BYTES);
    assert.ok(byteLength(answer) > VOICE_HERMES_MAX_ASSISTANT_BYTES);

    const result = await hermesReturning({ content: answer })
      .send('hi', { signal: new AbortController().signal });
    assert.equal(result.kind, 'error');
  });

  it('accepts an answer exactly at the byte cap, unaltered', async () => {
    const wideCount = Math.floor(VOICE_HERMES_MAX_ASSISTANT_BYTES / 3);
    const answer = WIDE.repeat(wideCount) + 'a'.repeat(VOICE_HERMES_MAX_ASSISTANT_BYTES - wideCount * 3);
    assert.equal(byteLength(answer), VOICE_HERMES_MAX_ASSISTANT_BYTES);

    const result = await hermesReturning({ content: answer })
      .send('hi', { signal: new AbortController().signal });
    assert.deepEqual(result, { kind: 'ok', assistantText: answer });
  });

  it('bounds the effective session id by bytes and keeps the old mapping when it will not fit', async () => {
    const client = hermesReturning({ content: 'ok', session_id: WIDE.repeat(VOICE_HERMES_MAX_SESSION_ID_BYTES - 1) });
    const before = client.sessionId;

    const result = await client.send('hi', { signal: new AbortController().signal });

    assert.equal(result.kind, 'error', 'an unbounded session id is not adopted');
    assert.equal(client.sessionId, before, 'and the configured mapping is unchanged');
  });
});

const TERMINATION_REASON_BYTES = 120;

describe('voice UTF-8 byte bounds — termination reason', () => {
  it('caps the echoed termination reason in bytes without splitting a surrogate pair', async () => {
    const harness = await startVoiceRelay();
    try {
      const cookie = await harness.login();
      const minted = await harness.raw({
        method: 'POST',
        path: '/api/voice/token',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(minted.status, 200, minted.body);
      const session = JSON.parse(minted.body) as { sessionId: string; epoch: number };

      // 119 ASCII code units plus one astral character: a 120-code-unit cut
      // lands between the surrogates and leaves half a code point behind.
      const reason = `${'r'.repeat(119)}${ASTRAL}`;
      assert.equal(reason.length, 121, 'the fixture straddles the cap by exactly one surrogate');

      const ended = await harness.raw({
        method: 'POST',
        path: '/api/voice/terminate',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, epoch: session.epoch, reason }),
      });
      assert.equal(ended.status, 200, ended.body);
      const echoed = (JSON.parse(ended.body) as { reason: string }).reason;

      assertBounded('termination reason', echoed, TERMINATION_REASON_BYTES);
    } finally {
      await harness.close();
    }
  });
});
