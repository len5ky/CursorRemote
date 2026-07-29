import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpHermesConversationReader } from '../src/server/transports/voice/context.js';
import { VoiceToolRouter } from '../src/server/transports/voice/tools.js';
import { VOICE_MAX_TOOL_OUTPUT_BYTES } from '../src/server/transports/voice/constants.js';
import { FakeHermesConversationReader } from './helpers/voice-fixtures.js';

/**
 * Byte budgets must be counted in bytes.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a cap written as
 * `slice(0, N)` lets a reply of N non-ASCII characters weigh up to 3N (4N with
 * astral characters) bytes on the wire — the ceiling the provider and the
 * sideband are sized against is silently blown by any non-English context.
 *
 * `maxTurns: 0` also has to mean zero turns. `slice(-0)` is `slice(0)`, which
 * returns the whole array, so the status tools that ask for no conversation
 * body were pulling every turn the endpoint offered.
 */

const MULTIBYTE = 'ありがとうございました。'; // 12 chars, 34 UTF-8 bytes

function readerReturning(body: unknown): HttpHermesConversationReader {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  return new HttpHermesConversationReader('https://hermes.example.test/context', '', fetchImpl);
}

function snapshotBody(turnCount: number, content = 'a short turn'): unknown {
  return {
    conversationId: 'conversation-1',
    revision: 'rev-1',
    observedAt: '2026-07-29T00:00:00.000Z',
    agentStatus: 'idle',
    sessions: [],
    turns: Array.from({ length: turnCount }, (_unused, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content,
    })),
  };
}

describe('hermes context bounds — maxTurns', () => {
  it('returns no turns at all when the caller asks for zero', async () => {
    const reader = readerReturning(snapshotBody(9));
    const result = await reader.readConversation({ maxTurns: 0, maxBytes: 4_000 });

    assert.equal(result.kind, 'available');
    assert.deepEqual(
      result.kind === 'available' ? result.snapshot.turns : null,
      [],
      'maxTurns: 0 must mean zero turns, not the whole transcript',
    );
  });

  it('honours a small positive turn budget', async () => {
    const reader = readerReturning(snapshotBody(9));
    const result = await reader.readConversation({ maxTurns: 2, maxBytes: 4_000 });

    assert.equal(result.kind, 'available');
    assert.equal(result.kind === 'available' ? result.snapshot.turns.length : -1, 2);
  });

  it('refuses a negative or non-integer turn budget instead of widening it', async () => {
    const reader = readerReturning(snapshotBody(9));
    const negative = await reader.readConversation({ maxTurns: -5, maxBytes: 4_000 });

    assert.equal(negative.kind, 'available');
    assert.equal(
      negative.kind === 'available' ? negative.snapshot.turns.length : -1,
      0,
      'a negative turn budget must not be read as "everything"',
    );
  });
});

describe('hermes context bounds — UTF-8 byte budget', () => {
  it('measures a long multibyte turn in bytes, not code units', async () => {
    const longMultibyte = MULTIBYTE.repeat(600); // ~20 KB of UTF-8
    const reader = readerReturning(snapshotBody(1, longMultibyte));
    const result = await reader.readConversation({ maxTurns: 4, maxBytes: 2_000 });

    assert.equal(result.kind, 'available');
    if (result.kind !== 'available') return;
    const serialized = Buffer.byteLength(JSON.stringify(result.snapshot), 'utf8');
    assert.ok(
      serialized <= 4_000,
      `a multibyte snapshot must respect its byte budget, saw ${serialized} bytes`,
    );
    for (const turn of result.snapshot.turns) {
      assert.equal(
        Buffer.from(turn.content, 'utf8').toString('utf8'),
        turn.content,
        'a truncated turn must still be valid UTF-8',
      );
    }
  });
});

describe('voice tool output — UTF-8 byte cap', () => {
  it('caps a multibyte tool reply by bytes and leaves it valid UTF-8', async () => {
    // Far more multibyte content than the output cap allows.
    const snapshot = FakeHermesConversationReader.snapshot({
      turns: Array.from({ length: 8 }, () => ({
        role: 'assistant' as const,
        content: MULTIBYTE.repeat(80),
      })),
    });
    const router = new VoiceToolRouter({
      contextReader: new FakeHermesConversationReader({ kind: 'available', snapshot }),
    });

    const result = await router.call('read_recent', { count: 8 });
    const bytes = Buffer.byteLength(result.output, 'utf8');

    assert.ok(
      bytes <= VOICE_MAX_TOOL_OUTPUT_BYTES,
      `tool output must be capped at ${VOICE_MAX_TOOL_OUTPUT_BYTES} UTF-8 bytes, saw ${bytes}`,
    );
    assert.equal(
      Buffer.from(result.output, 'utf8').toString('utf8'),
      result.output,
      'the cap must not split a multibyte character',
    );
  });

  it('leaves a short ASCII reply untouched', async () => {
    const router = new VoiceToolRouter({ contextReader: new FakeHermesConversationReader() });
    const result = await router.call('read_recent', { count: 2 });

    assert.equal(result.kind, 'ok');
    assert.match(result.output, /the migration is finished/);
  });
});
