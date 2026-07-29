import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { startVoiceRelay } from './helpers/voice-relay-harness.js';
import { FakeHermesAgent, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';

/**
 * A failure the operator needs and the caller must not get.
 *
 * The voice surface is reachable over a tailnet by anything that can hit the
 * port, including a caller with no session. What it says back is therefore a
 * disclosure channel: an env var name, a provider status, or an adapter reason
 * tells an unauthenticated caller how the deployment is wired and which knob is
 * missing. The operator still needs that detail, so it belongs in the server
 * log — every test here asserts both halves, because moving the detail out of
 * the body is only correct if it lands somewhere the operator can read it.
 */

/** Capture everything the relay prints while `work` runs. */
async function captureServerLogs<T>(work: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.log = capture; console.warn = capture; console.error = capture;
  try {
    const result = await work();
    return { result, logs: lines.join('\n') };
  } finally {
    console.log = originalLog; console.warn = originalWarn; console.error = originalError;
  }
}

/** Infrastructure detail that must never reach a client, in any response. */
const LEAKY = [
  /WEBAPP_PASSWORD/i,
  /VOICE_HERMES_[A-Z_]+/i,
  /OPENAI_API_KEY/i,
  /VOICE_[A-Z_]+/,
  /not configured/i,
  /is not set/i,
  /HTTP \d{3}/,
  /ECONN|ENOTFOUND|ETIMEDOUT|EADDR/,
  /\bstack\b|\bat .*\.ts:\d+/i,
];

function assertOpaque(body: string, context: string): void {
  for (const pattern of LEAKY) {
    assert.doesNotMatch(body, pattern, `${context} leaked infrastructure detail: ${body}`);
  }
}

describe('voice failure opacity — voice enabled without a password', () => {
  it('refuses without naming the setting that is missing, and logs which one it is', async () => {
    const { result, logs } = await captureServerLogs(async () => {
      const harness = await startVoiceRelay({ password: '', voiceEnabled: true });
      try {
        const routes = ['/api/voice/token', '/api/voice/call', '/api/voice/terminate', '/api/voice/heartbeat'];
        const responses = [];
        for (const path of routes) {
          responses.push({
            path,
            ...(await harness.raw({
              method: 'POST',
              path,
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            })),
          });
        }
        responses.push({ path: '/api/voice/status', ...(await harness.raw({ path: '/api/voice/status' })) });
        responses.push({ path: '/voice', ...(await harness.raw({ path: '/voice' })) });
        return responses;
      } finally {
        await harness.close();
      }
    });

    for (const response of result) {
      assert.equal(response.status, 503, `${response.path} must still refuse to serve`);
      assertOpaque(response.body, `${response.path} (unprotected voice)`);
    }

    assert.match(
      logs,
      /WEBAPP_PASSWORD/,
      'the operator has to be told which setting is missing; only the caller must not be',
    );
  });
});

describe('voice failure opacity — provider and adapter failures', () => {
  it('reports a provider mint failure generically and logs the provider cause', async () => {
    const { result, logs } = await captureServerLogs(async () => {
      const harness = await startVoiceRelay({ mintStatus: 502 });
      try {
        const cookie = await harness.login();
        return await harness.raw({
          method: 'POST',
          path: '/api/voice/token',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: '{}',
        });
      } finally {
        await harness.close();
      }
    });

    assert.equal(result.status, 500);
    assertOpaque(result.body, 'token mint failure');
    assert.match(logs, /\[voice\]|\[relay\]/, 'the mint failure must be logged server-side');
    assert.match(logs, /502|mint/i, 'the log must carry the actual provider cause');
  });

  it('reports a sideband attach failure generically and logs the adapter cause', async () => {
    const { result, logs } = await captureServerLogs(async () => {
      const harness = await startVoiceRelay({ sidebandFails: true });
      try {
        const cookie = await harness.login();
        const minted = await harness.raw({
          method: 'POST',
          path: '/api/voice/token',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: '{}',
        });
        const session = JSON.parse(minted.body) as { sessionId: string; epoch: number; attachToken: string };
        return await harness.raw({
          method: 'POST',
          path: '/api/voice/call',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            callId: 'provider-call-opacity',
            sessionId: session.sessionId,
            epoch: session.epoch,
            attachToken: session.attachToken,
          }),
        });
      } finally {
        await harness.close();
      }
    });

    assert.equal(result.status, 409);
    assertOpaque(result.body, 'sideband attach failure');
    assert.match(logs, /sideband|attach/i, 'the adapter cause must reach the server log');
  });
});

describe('voice failure opacity — Hermes turn failures', () => {
  const CONTEXT: VoiceSessionContext = { sessionId: 'session-opacity', epoch: 1, leaseId: 'lease-opacity' };

  /**
   * A Hermes turn that fails must produce silence, not an excuse.
   *
   * There is no safe way to explain the failure out loud: the reason names an
   * endpoint, an env var or an upstream status, and anything the provider is
   * handed it may read aloud to whoever is on the call. The operator still
   * needs the reason, so it goes to the server log and nowhere else.
   */
  async function failingTurn(reason: string): Promise<{ socket: FakeRealtimeSocket; logs: string }> {
    const sockets: FakeRealtimeSocket[] = [];
    const hermes = new FakeHermesAgent({ reply: () => ({ kind: 'error', reason }) });
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
    const { logs } = await captureServerLogs(async () => {
      await bridge.attachSideband('call-opacity', CONTEXT);
      sockets[0].sent.length = 0;
      sockets[0].emit('message', JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-opacity',
        transcript: 'where are we up to',
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    return { socket: sockets[0], logs };
  }

  it('says nothing at all when Hermes cannot answer, and logs why', async () => {
    const { socket, logs } = await failingTurn('hermes_unreachable');

    assert.deepEqual(socket.sentEvents(), [], 'a failed turn produces no provider write');
    assert.match(logs, /\[voice\]/, 'the operator must be told the turn failed');
    assert.match(logs, /hermes_unreachable/, 'the log carries the real cause');
  });

  it('keeps every failure reason out of anything handed to the provider', async () => {
    const reasons = [
      'hermes_unreachable',
      'hermes_http_503',
      'hermes_response_content_invalid',
      'hermes_capabilities_unreachable',
      'hermes_turn_aborted',
    ];

    for (const reason of reasons) {
      const { socket } = await failingTurn(reason);
      const written = JSON.stringify(socket.sentEvents());
      assert.equal(written, '[]', `reason "${reason}" must not reach the provider at all`);
      assertOpaque(written, `provider writes for "${reason}"`);
    }
  });

  it('speaks genuine Hermes content when the turn succeeds', async () => {
    const sockets: FakeRealtimeSocket[] = [];
    const hermes = new FakeHermesAgent({ reply: () => ({ kind: 'ok', assistantText: 'the migration is finished' }) });
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
    await bridge.attachSideband('call-opacity-ok', CONTEXT);
    sockets[0].emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-ok',
      transcript: 'where are we up to',
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const create = sockets[0].sentEvents().find((event) => event.type === 'response.create');
    assert.ok(create, 'a successful turn must be spoken');
    assert.match(JSON.stringify(create), /migration is finished/, 'real Hermes content must reach the operator');
  });
});
