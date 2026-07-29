import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import { VoiceToolRouter } from '../src/server/transports/voice/tools.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { FakeHermesConversationReader, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';
import { startVoiceRelay } from './helpers/voice-relay-harness.js';

/**
 * A termination that fails still has to answer the caller.
 *
 * The terminate route awaited the transport inside a `try`, matched the 403
 * ownership case, and then re-threw everything else out of an `async` handler
 * invoked as `void terminateVoice(req, res)`. Nothing was listening: the
 * rejection became an unhandled promise rejection, and — because the throw
 * happened after the response had been neither sent nor ended — the caller's
 * request hung until its own timeout. The phone's Hang up button appears to do
 * nothing, and the operator has no signal at all.
 *
 * The same shape existed on the tool path: `disconnect_voice` awaited
 * `terminateVoice` bare, so a failing termination rejected out of the tool
 * router, the sideband's catch-all swallowed it, and the model was left waiting
 * for a `function_call_output` that never arrived.
 *
 * A failure must be answered generically. The cause — a ledger path, an errno,
 * a provider status — is operator diagnostics and stays in the server log.
 */

const CONTEXT: VoiceSessionContext = { sessionId: 'session-fail', epoch: 1, leaseId: 'lease-fail' };

/** Detail that must never reach a client, in an error a real failure could carry. */
const INFRA_DETAIL = '/srv/relay/data/voice-usage.json';
const INFRA_ERROR = `EACCES: permission denied, open '${INFRA_DETAIL}'`;

function withDir<T>(name: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function makeTransport(dir: string): VoiceTransport {
  return new VoiceTransport(testVoiceConfig(), dir, new FakeHermesConversationReader(), {
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/client_secrets')) {
        return new Response(JSON.stringify({ value: 'ephemeral-browser-secret', expires_at: 123 }), { status: 200 });
      }
      if (url.includes('/hangup')) return new Response(null, { status: 200 });
      throw new Error(`unexpected provider call: ${url}`);
    }) as typeof fetch,
    websocketFactory: () => new FakeRealtimeSocket() as unknown as WebSocket,
  });
}

/** Collect any unhandled rejection raised while `run` executes. */
async function recordingUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => { seen.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    await run();
    // Unhandled rejections are reported a tick after the microtask queue drains.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

describe('voice termination failure — HTTP route', () => {
  it('answers a failing terminate with a generic error instead of hanging the request', async () => {
    const harness = await startVoiceRelay();
    const transport = harness.transport;
    assert.ok(transport, 'the harness attached a voice transport');
    try {
      const cookie = await harness.login();
      const minted = await fetch(`${harness.baseUrl}/api/voice/token`, {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(minted.status, 200);
      const session = await minted.json() as { sessionId: string; epoch: number };

      // A non-403 failure inside the transport, of the kind a broken ledger or
      // an unwritable data directory would produce.
      transport.terminate = async () => { throw new Error(INFRA_ERROR); };

      let response: Response | null = null;
      const rejections = await recordingUnhandledRejections(async () => {
        try {
          response = await fetch(`${harness.baseUrl}/api/voice/terminate`, {
            method: 'POST',
            headers: { cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: session.sessionId, epoch: session.epoch }),
            signal: AbortSignal.timeout(3_000),
          });
        } catch (err) {
          assert.fail(`a failing terminate must still answer the request, not hang: ${String(err)}`);
        }
      });

      assert.ok(response, 'the route responded');
      const answered = response as unknown as Response;
      assert.ok(
        answered.status >= 400 && answered.status < 600,
        `a failed termination is reported as an error status, got ${answered.status}`,
      );
      const body = await answered.text();
      assert.ok(!body.includes(INFRA_DETAIL), `the response must not carry infrastructure paths: ${body}`);
      assert.ok(!body.includes('EACCES'), `the response must not carry an errno: ${body}`);
      assert.deepEqual(rejections, [], 'a failing terminate must not produce an unhandled rejection');
    } finally {
      await harness.close();
    }
  });

  it('answers the attach route generically when its cleanup termination also fails', async () => {
    // The attach path terminates the session it just failed to attach. If that
    // cleanup termination throws too, the route still owes the caller one
    // generic answer — not a hang, not a rejection, not a provider detail.
    const harness = await startVoiceRelay({ sidebandFails: true });
    const transport = harness.transport;
    assert.ok(transport);
    try {
      const cookie = await harness.login();
      const minted = await harness.raw({
        method: 'POST',
        path: '/api/voice/token',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(minted.status, 200, minted.body);
      const session = JSON.parse(minted.body) as { sessionId: string; epoch: number; attachToken: string };

      transport.terminate = async () => { throw new Error(INFRA_ERROR); };

      let attach: { status: number; body: string } | null = null;
      const rejections = await recordingUnhandledRejections(async () => {
        attach = await harness.raw({
          method: 'POST',
          path: '/api/voice/call',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callId: 'provider-call-doomed',
            sessionId: session.sessionId,
            epoch: session.epoch,
            attachToken: session.attachToken,
          }),
        });
      });

      const answered = attach as unknown as { status: number; body: string };
      assert.ok(answered, 'the attach route responded');
      assert.equal(answered.status, 409, answered.body);
      assert.ok(!answered.body.includes(INFRA_DETAIL), `no infrastructure path in the body: ${answered.body}`);
      assert.ok(!answered.body.includes('EACCES'), `no errno in the body: ${answered.body}`);
      assert.deepEqual(rejections, [], 'a failing cleanup termination must not produce an unhandled rejection');
    } finally {
      await harness.close();
    }
  });

  it('still answers 403 for a cross-owner terminate rather than a generic failure', async () => {
    const harness = await startVoiceRelay();
    try {
      const cookieA = await harness.login();
      const cookieB = await harness.login();
      const minted = await harness.raw({
        method: 'POST',
        path: '/api/voice/token',
        headers: { Cookie: cookieA, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(minted.status, 200, minted.body);
      const session = JSON.parse(minted.body) as { sessionId: string; epoch: number };

      const refused = await harness.raw({
        method: 'POST',
        path: '/api/voice/terminate',
        headers: { Cookie: cookieB, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, epoch: session.epoch }),
      });
      assert.equal(refused.status, 403, refused.body);
    } finally {
      await harness.close();
    }
  });
});

describe('voice termination failure — tool path', () => {
  it('answers disconnect_voice generically when the termination fails', async () => {
    const router = new VoiceToolRouter(
      {
        contextReader: new FakeHermesConversationReader(),
        terminateVoice: async () => { throw new Error(INFRA_ERROR); },
      },
      { accepts: () => true, live: () => true },
    );

    const result = await router.call('disconnect_voice', {}, CONTEXT);

    assert.equal(result.ok, false, 'a failed termination is not reported as a success');
    assert.ok(!result.output.includes(INFRA_DETAIL), `the model must not be told the path: ${result.output}`);
    assert.ok(!result.output.includes('EACCES'), `the model must not be told the errno: ${result.output}`);
    assert.ok(result.output.length > 0, 'the model still receives a spoken-safe answer');
  });

  it('still reports a successful disconnect as a terminal state', async () => {
    const router = new VoiceToolRouter(
      {
        contextReader: new FakeHermesConversationReader(),
        terminateVoice: async () => ({ state: 'terminated' }),
      },
      { accepts: () => true, live: () => true },
    );
    const result = await router.call('disconnect_voice', {}, CONTEXT);
    assert.equal(result.ok, true);
    assert.match(result.output, /terminated/);
  });
});

describe('voice termination failure — internal callers', () => {
  it('does not reject termination when the hangup announcement throws', async () => {
    await withDir('voice-terminate-announce-fail', async (dir) => {
      const transport = makeTransport(dir);
      // The reaper and the provider-failure path both call terminate without a
      // caller to await them, so a throwing announcement must not become a
      // rejection there.
      transport.setHangupHandler(() => { throw new Error(INFRA_ERROR); });

      const live = await transport.mintClientSecret('account-a');
      await transport.attachCall('provider-call-announce', live.sessionId, live.epoch, live.attachToken, 'account-a');

      const rejections = await recordingUnhandledRejections(async () => {
        const result = await transport.terminate(live.sessionId, live.epoch, 'client_request', 'account-a');
        assert.equal(result.state, 'terminated', 'the session still terminates');
        assert.equal(result.sessionId, live.sessionId);
      });

      assert.deepEqual(rejections, [], 'a throwing hangup handler must not surface as an unhandled rejection');
      await transport.stop();
    });
  });
});
