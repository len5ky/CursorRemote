import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ClientOptions } from 'ws';
import type WebSocket from 'ws';
import { HttpHermesConversationReader } from '../src/server/transports/voice/context.js';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import type { ToolResult, VoiceToolRouter } from '../src/server/transports/voice/tools.js';
import { VOICE_MAX_TOOL_ARGUMENT_BYTES } from '../src/server/transports/voice/constants.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';
import { startVoiceRelay } from './helpers/voice-relay-harness.js';

/**
 * Every declared cap on this surface is a *byte* cap, and has to be enforced in
 * bytes.
 *
 * `String.prototype.slice` counts UTF-16 code units. A field capped with
 * `slice(0, N)` therefore passes through up to 3N bytes of BMP text (4N with
 * astral characters), so a Japanese conversation id, a session title with an
 * emoji, or a tool-call argument blob written in anything but English silently
 * blows the ceiling the sideband frame, the provider request and the context
 * budget are all sized against. The cut also has to land on a character
 * boundary: a value ending in half a code point is neither valid UTF-8 nor
 * something the model can read back.
 *
 * These caps are internal to the reader, so they are restated here as the
 * contract the parsed snapshot must satisfy.
 */

/** context.ts: identity fields. */
const IDENTITY_BYTES = { conversationId: 256, revision: 256, observedAt: 128, agentStatus: 128 };
/** context.ts: session metadata. */
const SESSION_BYTES = { id: 256, title: 256, status: 128, tabTitle: 256, tabStatus: 128 };
/** context.ts: per-turn body. */
const TURN_CONTENT_BYTES = 4_000;
/** realtime-bridge.ts: function-call identifiers echoed back to the provider. */
const TOOL_NAME_BYTES = 128;
const TOOL_CALL_ID_BYTES = 256;

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
  return !value.includes('�') && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function assertBounded(label: string, value: string, maxBytes: number): void {
  assert.ok(
    byteLength(value) <= maxBytes,
    `${label} must be capped in bytes: got ${byteLength(value)} bytes for a ${maxBytes}-byte cap`,
  );
  assert.ok(isValidUtf8(value), `${label} must remain valid UTF-8 after truncation`);
}

function readerReturning(body: unknown): HttpHermesConversationReader {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  return new HttpHermesConversationReader('https://hermes.example.test/context', '', fetchImpl);
}

describe('voice UTF-8 byte bounds — context identity and session metadata', () => {
  it('caps identity fields by encoded bytes, not by code units', async () => {
    const read = await readerReturning({
      // 200 code units, 600 bytes — under every character-counted cap, over every byte cap.
      conversationId: WIDE.repeat(200),
      revision: WIDE.repeat(200),
      observedAt: WIDE.repeat(200),
      agentStatus: WIDE.repeat(200),
      sessions: [],
      turns: [],
    }).readConversation();

    assert.equal(read.kind, 'available');
    if (read.kind !== 'available') return;
    assertBounded('conversationId', read.snapshot.conversationId, IDENTITY_BYTES.conversationId);
    assertBounded('revision', read.snapshot.revision, IDENTITY_BYTES.revision);
    assertBounded('observedAt', read.snapshot.observedAt, IDENTITY_BYTES.observedAt);
    assertBounded('agentStatus', read.snapshot.agentStatus, IDENTITY_BYTES.agentStatus);
  });

  it('cuts astral characters on a code-point boundary', async () => {
    // 64 astral characters = 128 code units = 256 bytes for a 128-byte cap.
    const read = await readerReturning({
      conversationId: 'conversation-1',
      revision: 'rev-1',
      observedAt: ASTRAL.repeat(64),
      agentStatus: ASTRAL.repeat(64),
      sessions: [],
      turns: [],
    }).readConversation();

    assert.equal(read.kind, 'available');
    if (read.kind !== 'available') return;
    assertBounded('observedAt', read.snapshot.observedAt, IDENTITY_BYTES.observedAt);
    assert.equal(
      read.snapshot.observedAt,
      ASTRAL.repeat(32),
      'a four-byte character must be dropped whole, never split across the cap',
    );
  });

  it('leaves a value that is exactly at its byte cap untouched', async () => {
    // 85 * 3 = 255 bytes, plus one ASCII byte = exactly the 256-byte cap.
    const exact = `${WIDE.repeat(85)}a`;
    assert.equal(byteLength(exact), IDENTITY_BYTES.conversationId);
    const read = await readerReturning({
      conversationId: exact,
      revision: 'rev-1',
      observedAt: '2026-07-29T00:00:00.000Z',
      agentStatus: 'idle',
      sessions: [],
      turns: [],
    }).readConversation();

    assert.equal(read.kind, 'available');
    if (read.kind !== 'available') return;
    assert.equal(read.snapshot.conversationId, exact, 'a value exactly at the cap is not truncated');
  });

  it('caps a value one byte over its cap without splitting a character', async () => {
    // 86 * 3 = 258 bytes: one character wholly past the 256-byte cap.
    const over = WIDE.repeat(86);
    const read = await readerReturning({
      conversationId: over,
      revision: 'rev-1',
      observedAt: '2026-07-29T00:00:00.000Z',
      agentStatus: 'idle',
      sessions: [],
      turns: [],
    }).readConversation();

    assert.equal(read.kind, 'available');
    if (read.kind !== 'available') return;
    assertBounded('conversationId', read.snapshot.conversationId, IDENTITY_BYTES.conversationId);
    assert.ok(
      over.startsWith(read.snapshot.conversationId),
      'truncation keeps a prefix of the supplied value',
    );
  });

  it('caps session metadata and tab metadata by encoded bytes', async () => {
    const read = await readerReturning({
      conversationId: 'conversation-1',
      revision: 'rev-1',
      observedAt: '2026-07-29T00:00:00.000Z',
      agentStatus: 'idle',
      sessions: [{
        id: WIDE.repeat(200),
        title: WIDE.repeat(200),
        status: WIDE.repeat(200),
        tabs: [{ title: WIDE.repeat(200), isActive: true, status: WIDE.repeat(200) }],
      }],
      turns: [],
    }).readConversation();

    assert.equal(read.kind, 'available');
    if (read.kind !== 'available') return;
    const session = read.snapshot.sessions[0];
    assert.ok(session, 'the session survives truncation rather than being dropped');
    assertBounded('session.id', session.id, SESSION_BYTES.id);
    assertBounded('session.title', session.title, SESSION_BYTES.title);
    assertBounded('session.status', session.status, SESSION_BYTES.status);
    assertBounded('tab.title', session.tabs[0].title, SESSION_BYTES.tabTitle);
    assertBounded('tab.status', session.tabs[0].status, SESSION_BYTES.tabStatus);
  });

  it('caps a turn body by encoded bytes', async () => {
    const read = await readerReturning({
      conversationId: 'conversation-1',
      revision: 'rev-1',
      observedAt: '2026-07-29T00:00:00.000Z',
      agentStatus: 'idle',
      sessions: [],
      // 2000 code units, 6000 bytes: under the character count, over the byte cap.
      turns: [{ role: 'assistant', content: WIDE.repeat(2_000), observedAt: WIDE.repeat(200) }],
    }).readConversation();

    assert.equal(read.kind, 'available');
    if (read.kind !== 'available') return;
    const turn = read.snapshot.turns[0];
    assert.ok(turn, 'the turn survives truncation rather than being dropped');
    assertBounded('turn.content', turn.content, TURN_CONTENT_BYTES);
    assertBounded('turn.observedAt', turn.observedAt ?? '', IDENTITY_BYTES.observedAt);
  });
});

describe('voice UTF-8 byte bounds — snapshot budget is a hard byte ceiling', () => {
  it('keeps the serialized snapshot inside the requested budget when metadata dominates it', async () => {
    // Metadata alone — 32 sessions of 32 tabs — is far larger than the budget a
    // status tool asks for, so trimming turns to zero cannot get under it.
    const sessions = Array.from({ length: 32 }, (_unused, index) => ({
      id: `session-${index}-${WIDE.repeat(60)}`,
      title: `title-${index}-${WIDE.repeat(60)}`,
      status: WIDE.repeat(30),
      tabs: Array.from({ length: 32 }, (_tab, tabIndex) => ({
        title: `tab-${tabIndex}-${WIDE.repeat(60)}`,
        isActive: tabIndex === 0,
        status: WIDE.repeat(30),
      })),
    }));
    const maxBytes = 2_000;
    const read = await readerReturning({
      conversationId: 'conversation-1',
      revision: 'rev-1',
      observedAt: '2026-07-29T00:00:00.000Z',
      agentStatus: 'idle',
      sessions,
      turns: [{ role: 'user', content: WIDE.repeat(500) }],
    }).readConversation({ maxTurns: 0, maxBytes });

    assert.equal(read.kind, 'available');
    if (read.kind !== 'available') return;
    const serialized = JSON.stringify(read.snapshot);
    assert.ok(
      byteLength(serialized) <= maxBytes,
      `the snapshot must fit the declared byte budget: got ${byteLength(serialized)} bytes for a ${maxBytes}-byte budget`,
    );
    assert.equal(read.snapshot.turns.length, 0, 'a zero turn budget still means zero turns');
    assert.ok(isValidUtf8(serialized), 'the serialized snapshot stays valid UTF-8');
  });

  it('does not widen a caller byte budget below the default floor', async () => {
    // Each identity field is individually valid, but the complete metadata
    // envelope is larger than this deliberately small caller budget. A minimum
    // floor would return it anyway and violate the declared 256-byte ceiling.
    const maxBytes = 256;
    const metadata = 'm'.repeat(80);
    const read = await readerReturning({
      conversationId: metadata,
      revision: metadata,
      observedAt: metadata,
      agentStatus: metadata,
      sessions: [],
      turns: [],
    }).readConversation({ maxTurns: 0, maxBytes });

    assert.equal(read.kind, 'unavailable', 'an identity envelope that cannot fit is unavailable');
  });

  it('reports unavailable rather than returning a snapshot it cannot fit in the budget', async () => {
    // Control characters are JSON-escaped to six bytes each, so identity fields
    // that are individually within their caps can still not fit any budget.
    // Honest unavailability beats an over-budget snapshot or a fabricated id.
    const control = '\u0001'.repeat(256);
    const read = await readerReturning({
      conversationId: control,
      revision: control,
      observedAt: '\u0001'.repeat(128),
      agentStatus: '\u0001'.repeat(128),
      sessions: [],
      turns: [],
    }).readConversation({ maxTurns: 0, maxBytes: 1 });

    assert.equal(read.kind, 'unavailable', 'an unfittable snapshot is unavailable, not over budget');
  });
});

interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

function makeBridge(): {
  bridge: RealtimeBridge;
  sockets: FakeRealtimeSocket[];
  calls: RecordedCall[];
  failures: string[];
} {
  const calls: RecordedCall[] = [];
  const sockets: FakeRealtimeSocket[] = [];
  const failures: string[] = [];
  const router = {
    call: async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      calls.push({ name, args });
      return { kind: 'ok', ok: true, output: 'router reached' };
    },
  } as unknown as VoiceToolRouter;
  const bridge = new RealtimeBridge(testVoiceConfig(), router, {
    accepts: () => true,
    userTurn: () => {},
    providerFailure: (_context, reason) => { failures.push(reason); },
    reportSpend: () => true,
  }, {
    fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    websocketFactory: (_url: string, _options: ClientOptions) => {
      const socket = new FakeRealtimeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  return { bridge, sockets, calls, failures };
}

function outputsFor(socket: FakeRealtimeSocket): Array<{ call_id?: string; output?: string }> {
  return socket.sentEvents()
    .filter((event) => event.type === 'conversation.item.create')
    .map((event) => event.item as { call_id?: string; output?: string });
}

describe('voice UTF-8 byte bounds — Realtime tool arguments', () => {
  it('refuses a tool-call argument blob that is over the byte cap but under the code-unit count', async () => {
    const { bridge, sockets, calls, failures } = makeBridge();
    await bridge.attachSideband('provider-call-args', CONTEXT);
    const socket = sockets[0];

    // 3000 wide characters: ~3015 code units (under the cap read as characters)
    // but ~9020 bytes (well over the declared 8192-byte cap).
    const args = JSON.stringify({ note: WIDE.repeat(3_000) });
    assert.ok(args.length <= VOICE_MAX_TOOL_ARGUMENT_BYTES, 'the fixture is under the cap when counted as characters');
    assert.ok(byteLength(args) > VOICE_MAX_TOOL_ARGUMENT_BYTES, 'the fixture is over the cap when counted as bytes');

    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'read_recent',
      call_id: 'fc-wide-args',
      arguments: args,
    })));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(calls, [], 'an over-cap argument blob must never reach the tool router');
    // The refusal is *non-writing*: an envelope that broke its declared bound is
    // untrusted in every field, including the call_id an answer would have to be
    // addressed to, so nothing is created in the provider conversation and the
    // session ends with a definite reason instead.
    assert.deepEqual(outputsFor(socket), [], 'an out-of-bounds envelope produces no provider write');
    assert.deepEqual(failures, ['provider_tool_envelope_rejected']);
    bridge.detach();
  });

  it('still accepts an argument blob exactly at the byte cap', async () => {
    const { bridge, sockets, calls } = makeBridge();
    await bridge.attachSideband('provider-call-args-exact', CONTEXT);
    const socket = sockets[0];

    const envelope = '{"pad":"'.length + '"}'.length;
    const args = `{"pad":"${'a'.repeat(VOICE_MAX_TOOL_ARGUMENT_BYTES - envelope)}"}`;
    assert.equal(byteLength(args), VOICE_MAX_TOOL_ARGUMENT_BYTES);

    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'get_status',
      call_id: 'fc-exact-args',
      arguments: args,
    })));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.length, 1, 'an argument blob exactly at the cap is still served');
    assert.equal(calls[0].name, 'get_status');
    bridge.detach();
  });

  it('bounds the function name and call id by bytes, not by code units', async () => {
    // Each fixture is *under* its cap when the cap is misread as a count of
    // UTF-16 code units, and *over* it in the UTF-8 bytes the cap is declared
    // in. Only a byte-counted bound rejects them, so a `.length` check — the
    // bug this whole file exists to catch — would let both through.
    const cases: Array<{ label: string; name: string; callId: string }> = [
      {
        label: 'function name',
        name: WIDE.repeat(100), // 100 code units (≤128), 300 bytes (>128)
        callId: 'fc-wide-name',
      },
      {
        label: 'call id',
        name: 'get_status',
        callId: WIDE.repeat(200), // 200 code units (≤256), 600 bytes (>256)
      },
    ];

    for (const testCase of cases) {
      assert.ok(testCase.name.length <= TOOL_NAME_BYTES, `${testCase.label}: name is under the cap as code units`);
      assert.ok(testCase.callId.length <= TOOL_CALL_ID_BYTES, `${testCase.label}: call id is under the cap as code units`);
      assert.ok(
        byteLength(testCase.name) > TOOL_NAME_BYTES || byteLength(testCase.callId) > TOOL_CALL_ID_BYTES,
        `${testCase.label}: the fixture is over the cap in bytes`,
      );

      const { bridge, sockets, calls, failures } = makeBridge();
      await bridge.attachSideband('provider-call-ids', CONTEXT);
      const socket = sockets[0];

      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.function_call_arguments.done',
        name: testCase.name,
        call_id: testCase.callId,
        arguments: '{}',
      })));
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Unlike the argument blob, these are never truncated to fit: a shortened
      // call_id names a *different* call, so answering it would write a tool
      // output against an identifier the model never issued.
      assert.deepEqual(calls, [], `an over-byte ${testCase.label} must never reach the tool router`);
      assert.deepEqual(outputsFor(socket), [], `an over-byte ${testCase.label} produces no provider write`);
      assert.deepEqual(failures, ['provider_tool_envelope_rejected']);
      bridge.detach();
    }
  });

  it('still serves a multibyte name and call id that genuinely fit their byte caps', async () => {
    const { bridge, sockets, calls, failures } = makeBridge();
    await bridge.attachSideband('provider-call-ids-ok', CONTEXT);
    const socket = sockets[0];

    // 30 wide characters is 90 bytes — comfortably inside both caps, so the
    // bound must not be a blanket refusal of anything non-ASCII.
    const name = WIDE.repeat(30);
    const callId = WIDE.repeat(30);
    assertBounded('tool name', name, TOOL_NAME_BYTES);
    assertBounded('tool call id', callId, TOOL_CALL_ID_BYTES);

    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.done',
      name,
      call_id: callId,
      arguments: '{}',
    })));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(calls.length, 1, 'an in-bounds call still reaches the router');
    assert.equal(calls[0].name, name, 'the name reaches the router intact, not truncated');
    const echoed = outputsFor(socket)[0];
    assert.ok(echoed, 'the provider is answered for the call it actually made');
    assert.equal(echoed.call_id, callId, 'the answer is addressed to the exact call id the model issued');
    assert.deepEqual(failures, [], 'an in-bounds envelope does not end the call');
    bridge.detach();
  });
});

/** relay.ts: the client-supplied termination reason echoed back in the status. */
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
