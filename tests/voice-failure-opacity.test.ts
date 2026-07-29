import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceToolRouter } from '../src/server/transports/voice/tools.js';
import { startVoiceRelay } from './helpers/voice-relay-harness.js';
import { FakeHermesConversationReader, testVoiceConfig } from './helpers/voice-fixtures.js';

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
  /HERMES_READ_CONTEXT_URL/i,
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

describe('voice failure opacity — Hermes context adapter', () => {
  const router = (reason: string) => new VoiceToolRouter(
    {
      contextReader: FakeHermesConversationReader.unavailable(reason),
      terminateVoice: async () => ({ state: 'terminated' }),
    },
    { accepts: () => true, live: () => true },
  );

  const CONTEXT = { sessionId: 'session-opacity', epoch: 1, leaseId: 'lease-opacity' };

  it('tells the model the context is unavailable without reciting the deployment reason', async () => {
    const { result, logs } = await captureServerLogs(async () =>
      router('HERMES_READ_CONTEXT_URL is not configured').call('read_recent', {}, CONTEXT));

    assert.equal(result.kind, 'context_unavailable');
    assert.match(
      result.output,
      /unavailable/i,
      'the honest "unavailable" signal must survive; only the infrastructure reason is dropped',
    );
    assertOpaque(result.output, 'read_recent unavailable output');

    assert.match(
      logs,
      /HERMES_READ_CONTEXT_URL is not configured/,
      'the operator needs the real reason the context could not be read',
    );
  });

  it('keeps every unavailable reason out of what the model is told to say', async () => {
    const reasons = [
      'HERMES_READ_CONTEXT_URL is not configured',
      'Hermes read endpoint returned HTTP 503',
      'Hermes read endpoint could not be reached',
      'Hermes read response did not match the documented schema',
      'Hermes read endpoint must use HTTPS or loopback HTTP',
    ];

    for (const reason of reasons) {
      const { result } = await captureServerLogs(async () =>
        router(reason).call('get_status', {}, CONTEXT));
      assert.equal(result.kind, 'context_unavailable');
      assertOpaque(result.output, `get_status with reason "${reason}"`);
      assert.doesNotMatch(result.output, /Hermes read (endpoint|response)/, 'no adapter internals in spoken output');
    }
  });

  it('still reports genuine context when Hermes is available', async () => {
    const available = new VoiceToolRouter(
      {
        contextReader: new FakeHermesConversationReader(),
        terminateVoice: async () => ({ state: 'terminated' }),
      },
      { accepts: () => true, live: () => true },
    );
    const result = await available.call('read_recent', {}, CONTEXT);

    assert.equal(result.kind, 'ok');
    assert.match(result.output, /migration is finished/, 'real Hermes content must still reach the model');
  });
});
