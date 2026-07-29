import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import { HermesSessionChatClient } from '../src/server/transports/voice/hermes-chat.js';
import {
  FakeHermesAgent,
  FakeRealtimeSocket,
  hermesCapabilities,
  hermesToolsets,
  testVoiceConfig,
} from './helpers/voice-fixtures.js';
import { startVoiceRelay } from './helpers/voice-relay-harness.js';

/**
 * Admission is gated on the one enforcement point this design has.
 *
 * The Hermes session-chat API has no per-request tool disable, so Voice V1
 * depends on a deployment whose documented `/v1/toolsets` response has exactly
 * zero effective toolsets, with MCP disabled. That is a deployment fact, not a
 * prompt, and the only way the relay can enforce that boundary is the explicit
 * server response. A call admitted without that declaration is a live microphone
 * wired to a backend nobody has checked, so admission fails closed — before any
 * provider I/O, before any spend.
 */

const ROUTE = testVoiceConfig().hermes;

function withDir<T>(name: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function providerDoubles(providerCalls: string[]) {
  return {
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      providerCalls.push(url);
      if (url.endsWith('/client_secrets')) {
        return new Response(JSON.stringify({ value: 'ephemeral-browser-secret', model: 'gpt-realtime-2.1' }), { status: 200 });
      }
      if (url.includes('/hangup')) return new Response(null, { status: 200 });
      throw new Error(`unexpected provider call: ${url}`);
    }) as typeof fetch,
    websocketFactory: () => new FakeRealtimeSocket() as unknown as WebSocket,
  };
}

/** Capture everything the relay prints while `work` runs. */
async function captureLogs<T>(work: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.log = capture; console.warn = capture; console.error = capture;
  try {
    const result = await work();
    return { result, logs: lines.join('\n') };
  } finally {
    console.log = original.log; console.warn = original.warn; console.error = original.error;
  }
}

describe('voice admission — uncertified Hermes tool policy fails closed', () => {
  it('refuses to mint a provider credential when the deployment is not certified', async () => {
    await withDir('voice-hermes-admission-denied', async (dir) => {
      const providerCalls: string[] = [];
      const hermes = new FakeHermesAgent({ policy: { ok: false, reason: 'hermes_mcp_not_disabled' } });
      const transport = new VoiceTransport(testVoiceConfig(), dir, hermes, providerDoubles(providerCalls));

      const { logs } = await captureLogs(async () => {
        await assert.rejects(transport.mintClientSecret('owner-a'), /unavailable/i);
      });

      assert.deepEqual(providerCalls, [], 'no provider call may be made before the policy is certified');
      assert.equal(transport.status.state, 'idle', 'no session may be admitted');
      assert.match(logs, /hermes_mcp_not_disabled/, 'the operator is told which policy check failed');
      await transport.stop();
    });
  });

  it('refuses when the policy check itself throws', async () => {
    await withDir('voice-hermes-admission-throw', async (dir) => {
      const providerCalls: string[] = [];
      const hermes = new FakeHermesAgent();
      hermes.verifyPolicy = async () => { throw new Error('connection refused'); };
      const transport = new VoiceTransport(testVoiceConfig(), dir, hermes, providerDoubles(providerCalls));

      await captureLogs(async () => {
        await assert.rejects(transport.mintClientSecret('owner-a'));
      });
      assert.deepEqual(providerCalls, []);
      await transport.stop();
    });
  });

  it('admits once the deployment certifies, and does not re-ask on every mint', async () => {
    await withDir('voice-hermes-admission-ok', async (dir) => {
      const providerCalls: string[] = [];
      const hermes = new FakeHermesAgent();
      const transport = new VoiceTransport(testVoiceConfig(), dir, hermes, providerDoubles(providerCalls));

      const minted = await transport.mintClientSecret('owner-a');
      assert.equal(minted.clientSecret, 'ephemeral-browser-secret');
      assert.equal(hermes.policyCalls, 1);
      assert.equal(transport.status.health.hermes, true, 'health reports a certified conversational authority');
      assert.equal(transport.status.hermesCertified, true);
      assert.equal(transport.available, true, 'the transport agrees with its own status report');

      await transport.terminate(minted.sessionId, minted.epoch, 'client_request', 'owner-a');
      await transport.mintClientSecret('owner-a');
      assert.equal(hermes.policyCalls, 1, 'a fresh certification is cached, not re-asked per call');
      await transport.stop();
    });
  });

  it('certifies the live capabilities report, refusing a permissive one', async () => {
    for (const [capabilities, admits] of [
      [hermesCapabilities(), true],
      [hermesCapabilities({ mcp: { enabled: true } }), false],
      [hermesCapabilities({ endpoints: {} }), false],
      [hermesCapabilities({ platform: 'shared' }), false],
    ] as Array<[Record<string, unknown>, boolean]>) {
      await withDir('voice-hermes-admission-live', async (dir) => {
        const providerCalls: string[] = [];
        const config = testVoiceConfig();
        const hermes = new HermesSessionChatClient(config.hermes, {
          fetchImpl: (async (input: RequestInfo | URL) => {
            if (String(input).endsWith(config.hermes.capabilitiesPath)) {
              return new Response(JSON.stringify(capabilities), { status: 200 });
            }
            if (String(input).endsWith(config.hermes.toolsetsPath)) {
              return new Response(JSON.stringify(hermesToolsets()), { status: 200 });
            }
            throw new Error(`unexpected Hermes call: ${String(input)}`);
          }) as typeof fetch,
        });
        const transport = new VoiceTransport(config, dir, hermes, providerDoubles(providerCalls));

        await captureLogs(async () => {
          if (admits) await transport.mintClientSecret('owner-a');
          else await assert.rejects(transport.mintClientSecret('owner-a'));
        });
        assert.equal(providerCalls.length > 0, admits);
        await transport.stop();
      });
    }
  });
});

describe('voice startup — comes up honest about whether it can be used', () => {
  it('does not report itself ready when the deployment has not certified', async () => {
    await withDir('voice-hermes-start-uncertified', async (dir) => {
      const providerCalls: string[] = [];
      const hermes = new FakeHermesAgent({ policy: { ok: false, reason: 'hermes_capabilities_unreachable' } });
      const transport = new VoiceTransport(testVoiceConfig(), dir, hermes, providerDoubles(providerCalls));

      const { logs } = await captureLogs(async () => { await transport.start(); });

      assert.doesNotMatch(logs, /Transport ready/, 'a transport that cannot place a call must not claim to be ready');
      assert.match(logs, /UNAVAILABLE/, 'the boot log must say plainly that voice cannot be used');
      assert.match(logs, /hermes_capabilities_unreachable/, 'and why');

      assert.equal(transport.available, false);
      assert.equal(transport.status.hermesCertified, false);
      assert.equal(transport.status.health.hermes, false);

      // Fail closed, but keep running: admission refuses while the rest of the
      // relay (web, Telegram) stays up. A Hermes blip must not take them down.
      await captureLogs(async () => {
        await assert.rejects(transport.mintClientSecret('owner-a'), /unavailable/i);
      });
      assert.deepEqual(providerCalls, [], 'and no provider spend is incurred while it is unusable');
      await transport.stop();
    });
  });

  it('reports ready, once, when the deployment certifies at boot', async () => {
    await withDir('voice-hermes-start-certified', async (dir) => {
      const hermes = new FakeHermesAgent();
      const transport = new VoiceTransport(testVoiceConfig(), dir, hermes, providerDoubles([]));

      const { logs } = await captureLogs(async () => { await transport.start(); });

      assert.match(logs, /Transport ready/);
      assert.doesNotMatch(logs, /UNAVAILABLE/);
      assert.equal(transport.available, true);
      assert.equal(hermes.policyCalls, 1, 'boot certification is the same check admission uses');
      await transport.stop();
    });
  });

  it('answers 503, not 500, when a call is refused on an uncertified deployment', async () => {
    const harness = await startVoiceRelay({ hermesPolicyFails: true });
    try {
      const cookie = await harness.login();
      const { result } = await captureLogs(async () => harness.raw({
        method: 'POST',
        path: '/api/voice/token',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      }));

      // 503 is the honest code: this is not an unexpected failure, it is a
      // surface deliberately refusing on a precondition the deployment has not
      // met — the same answer an unwired transport gives.
      assert.equal(result.status, 503, result.body);
      assert.match(result.body, /unavailable/i);
      // And it still says nothing about which precondition, or about Hermes.
      assert.doesNotMatch(result.body, /hermes|mcp|toolset|capabilit/i);
      assert.deepEqual(harness.providerCalls, [], 'no provider call is made for a refused admission');
    } finally {
      await harness.close();
    }
  });
});

describe('voice hermes identity — server state, never request input', () => {
  it('uses the configured mapping however hard the browser tries to choose another', async () => {
    await withDir('voice-hermes-identity', async (dir) => {
      const providerCalls: string[] = [];
      const hermesCalls: string[] = [];
      const sockets: FakeRealtimeSocket[] = [];
      const hermes = new HermesSessionChatClient(ROUTE, {
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          hermesCalls.push(url);
          if (url.endsWith(ROUTE.capabilitiesPath)) {
            return new Response(JSON.stringify(hermesCapabilities()), { status: 200 });
          }
          if (url.endsWith(ROUTE.toolsetsPath)) {
            return new Response(JSON.stringify(hermesToolsets()), { status: 200 });
          }
          return new Response(JSON.stringify({ content: 'answered' }), { status: 200 });
        }) as typeof fetch,
      });
      const transport = new VoiceTransport(testVoiceConfig(), dir, hermes, {
        ...providerDoubles(providerCalls),
        websocketFactory: () => {
          const socket = new FakeRealtimeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });

      const minted = await transport.mintClientSecret('owner-a');
      await transport.attachCall('provider-call-identity', minted.sessionId, minted.epoch, minted.attachToken, 'owner-a');

      // The provider is the only thing that can reach the bridge, and the only
      // field it supplies is the transcript. Even a hostile event carrying a
      // session id and key cannot redirect the turn.
      sockets[0].emit('message', JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        transcript: 'whose history is this',
        session_id: 'attacker-session',
        hermes_session_key: 'attacker-key',
      }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const chat = hermesCalls.filter((url) => url.endsWith('/chat'));
      assert.equal(chat.length, 1);
      assert.equal(chat[0], `${ROUTE.apiUrl}/api/sessions/${ROUTE.sessionId}/chat`);
      assert.doesNotMatch(chat[0], /attacker/);
      await transport.stop();
    });
  });

  it('exposes no Hermes identity through any authenticated relay route', async () => {
    const harness = await startVoiceRelay();
    try {
      const cookie = await harness.login();
      const bodies: string[] = [];

      const minted = await harness.raw({
        method: 'POST',
        path: '/api/voice/token',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        // A browser trying to name the Hermes session it wants to talk to.
        body: JSON.stringify({
          hermesSessionId: 'attacker-session',
          hermesSessionKey: 'attacker-key',
          sessionId: 'attacker-session',
        }),
      });
      assert.equal(minted.status, 200, minted.body);
      bodies.push(minted.body);
      const session = JSON.parse(minted.body) as { sessionId: string; epoch: number; attachToken: string };
      assert.notEqual(session.sessionId, 'attacker-session', 'the voice session id is minted, never supplied');

      bodies.push((await harness.raw({ path: '/api/voice/status', headers: { Cookie: cookie } })).body);
      bodies.push((await harness.raw({
        method: 'POST',
        path: '/api/voice/terminate',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, epoch: session.epoch }),
      })).body);

      for (const body of bodies) {
        for (const secret of [ROUTE.apiKey, ROUTE.sessionKey, ROUTE.sessionId]) {
          assert.doesNotMatch(body, new RegExp(secret), `a browser-facing body leaked Hermes identity: ${body}`);
        }
      }
    } finally {
      await harness.close();
    }
  });

  it('keeps Hermes credentials out of the server log on every path', async () => {
    await withDir('voice-hermes-logs', async (dir) => {
      const providerCalls: string[] = [];
      const sockets: FakeRealtimeSocket[] = [];
      // A deployment that certifies, then fails the turn with an upstream body
      // echoing both credentials back at us.
      let call = 0;
      const hermes = new HermesSessionChatClient(ROUTE, {
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.endsWith(ROUTE.capabilitiesPath)) {
            return new Response(JSON.stringify(hermesCapabilities()), { status: 200 });
          }
          if (url.endsWith(ROUTE.toolsetsPath)) {
            return new Response(JSON.stringify(hermesToolsets()), { status: 200 });
          }
          call += 1;
          return new Response(
            `upstream failure: bearer ${ROUTE.apiKey} session ${ROUTE.sessionKey} (${ROUTE.sessionId})`,
            { status: 500 },
          );
        }) as typeof fetch,
      });
      const transport = new VoiceTransport(testVoiceConfig(), dir, hermes, {
        ...providerDoubles(providerCalls),
        websocketFactory: () => {
          const socket = new FakeRealtimeSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      });

      const { logs } = await captureLogs(async () => {
        const minted = await transport.mintClientSecret('owner-a');
        await transport.attachCall('provider-call-logs', minted.sessionId, minted.epoch, minted.attachToken, 'owner-a');
        sockets[0].emit('message', JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'item-1',
          transcript: 'anything',
        }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        await transport.terminate(minted.sessionId, minted.epoch, 'client_request', 'owner-a');
      });

      assert.ok(call > 0, 'the turn must actually have been attempted');
      for (const secret of [ROUTE.apiKey, ROUTE.sessionKey]) {
        assert.doesNotMatch(logs, new RegExp(secret), 'a Hermes credential reached the server log');
      }
      assert.doesNotMatch(logs, /upstream failure/, 'raw upstream error bodies are never logged verbatim');
      assert.match(logs, /hermes_http_500/, 'but the operator still gets a coarse, actionable reason');

      // And nothing was spoken about it.
      assert.equal(
        sockets[0].sentEvents().some((event) => event.type === 'response.create'),
        false,
      );
      await transport.stop();
    });
  });
});
