import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type WebSocket from 'ws';
import { Relay } from '../src/server/relay.js';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import type { CDPBridge } from '../src/server/cdp-bridge.js';
import type { CommandExecutor } from '../src/server/command-executor.js';
import type { StateManager } from '../src/server/state-manager.js';
import type { ServerConfig } from '../src/server/types.js';
import { FakeRealtimeSocket, hermesCapabilities, hermesToolsets, testVoiceConfig } from './helpers/voice-fixtures.js';
import {
  HermesSessionChatClient,
  HERMES_SESSION_KEY_HEADER,
} from '../src/server/transports/voice/hermes-chat.js';


/**
 * Local mocked provider/sideband smoke.
 *
 * Exercises the real relay HTTP surface, the real bridge orchestration and the
 * real Hermes session-chat client:
 *   authenticated token -> fake ephemeral credential -> fake provider call id
 *   -> server sideband attach -> final transcript -> server-to-server Hermes
 *   session chat -> out-of-band audio rendering of the Hermes answer
 *   -> explicit hangup -> provider hangup acknowledged
 *
 * Every provider and Hermes interaction is a double. Nothing here reaches
 * api.openai.com or a real Hermes deployment, and this proves relay/bridge
 * orchestration only — never live audio quality.
 */

const PASSWORD = 'smoke-test-password';
const SERVER_KEY = 'server-only-standard-key';
const HERMES_ANSWER = 'the migration finished about an hour ago';

function stubStateManager(): StateManager {
  return Object.assign(new EventEmitter(), {
    getCurrentState: () => ({
      connected: false, extractorStatus: 'idle', lastExtractionAt: null,
      consecutiveExtractionFailures: 0, lastExtractionError: null,
      agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
      agentActivitySource: 'none' as const, messages: [], pendingApprovals: [],
      inputAvailable: false, chatTabs: [], activeComposerId: '',
      mode: { current: '', available: [] }, model: { current: '', currentId: '' },
      windows: [], activeWindowId: '', composerQueue: { items: [] }, questionnaire: null,
    }),
    generation: 0,
  }) as unknown as StateManager;
}

describe('private voice mocked provider lifecycle smoke', () => {
  let relay: Relay;
  let transport: VoiceTransport;
  let baseUrl: string;
  let dataDir: string;
  let socket: FakeRealtimeSocket | null = null;
  const providerCalls: string[] = [];
  const hermesCalls: Array<{ url: string; init: RequestInit }> = [];

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'private-voice-smoke-'));

    const config = {
      cdpUrl: 'http://127.0.0.1:9222',
      serverPort: 0,
      serverHost: '127.0.0.1',
      pollIntervalMs: 300,
      debounceMs: 150,
      selectorsPath: './selectors.json',
      logLevel: 'error',
      webappPassword: PASSWORD,
      windowTitleQualifier: true,
      dataDir,
      telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'grammy' as const },
      voice: testVoiceConfig({ openaiApiKey: SERVER_KEY }),
    } as unknown as ServerConfig;

    relay = new Relay(
      config,
      stubStateManager(),
      {} as CommandExecutor,
      { on: () => {}, off: () => {} } as unknown as CDPBridge,
    );

    const hermes = new HermesSessionChatClient(config.voice.hermes, {
      fetchImpl: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        hermesCalls.push({ url, init });
        if (url.endsWith(config.voice.hermes.capabilitiesPath)) return new Response(JSON.stringify(hermesCapabilities()), { status: 200 });
        if (url.endsWith(config.voice.hermes.toolsetsPath)) return new Response(JSON.stringify(hermesToolsets()), { status: 200 });
        if (url.endsWith('/chat')) return new Response(JSON.stringify({ content: HERMES_ANSWER }), { status: 200 });
        throw new Error(`unexpected hermes call: ${url}`);
      }) as typeof fetch,
    });

    transport = new VoiceTransport(config.voice, dataDir, hermes, {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        providerCalls.push(url);
        if (url.endsWith('/client_secrets')) {
          return new Response(JSON.stringify({ value: 'ephemeral-browser-secret', expires_at: 4102444800, model: 'gpt-realtime-2.1' }), { status: 200 });
        }
        if (url.includes('/hangup')) return new Response(null, { status: 200 });
        throw new Error(`unexpected provider call: ${url}`);
      }) as typeof fetch,
      websocketFactory: () => {
        socket = new FakeRealtimeSocket();
        return socket as unknown as WebSocket;
      },
    });

    relay.setVoiceTransport(transport);
    await relay.start();
    const address = (relay as unknown as { httpServer: { address(): AddressInfo } }).httpServer.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await transport.stop();
    await (relay as unknown as { httpServer: { close(cb: () => void): void } }).httpServer.close(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  let cookie = '';
  let sessionId = '';
  let epoch = 0;
  let attachToken = '';

  it('refuses the voice API and the voice page without authentication', async () => {
    const token = await fetch(`${baseUrl}/api/voice/token`, { method: 'POST' });
    assert.equal(token.status, 401, 'token minting must require authentication');

    const page = await fetch(`${baseUrl}/voice`, { redirect: 'manual' });
    assert.equal(page.status, 302, 'the voice page must redirect to login');
    // Back into the installed PWA scope, not out to the remote-control root.
    assert.equal(page.headers.get('location'), '/login?next=%2Fvoice');
  });

  it('authenticates and mints a browser-only credential with no-store', async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    assert.ok(cookie, 'login must set a session cookie');

    const response = await fetch(`${baseUrl}/api/voice/token`, { method: 'POST', headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);

    const body = await response.json() as Record<string, unknown>;
    sessionId = String(body.sessionId);
    epoch = Number(body.epoch);
    attachToken = String(body.attachToken);

    assert.equal(body.clientSecret, 'ephemeral-browser-secret');
    assert.ok(sessionId && Number.isInteger(epoch) && attachToken);

    // The standard key must never appear in the browser-facing response.
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, new RegExp(SERVER_KEY));
    assert.ok(providerCalls.some((u) => u.endsWith('/client_secrets')));
  });

  it('serves the authenticated voice page with a microphone-scoped policy', async () => {
    const page = await fetch(`${baseUrl}/voice`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('permissions-policy') ?? '', /microphone=\(self\)/);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self' https:\/\/api\.openai\.com/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /Private voice/);
  });

  it('attaches the sideband for the admitted call', async () => {
    const response = await fetch(`${baseUrl}/api/voice/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ callId: 'provider-call-smoke', sessionId, epoch, attachToken }),
    });
    assert.equal(response.status, 200);
    assert.ok(socket, 'the sideband socket must be opened');

    // The relay asserts its tool set and pinned model on session.created.
    socket!.emit('message', Buffer.from(JSON.stringify({ type: 'session.created', session: { model: 'gpt-realtime-2.1' } })));
    await new Promise((r) => setTimeout(r, 10));
    const update = socket!.sentEvents().find((e) => e.type === 'session.update');
    assert.ok(update, 'the relay must re-assert its session config');
    assert.equal((update!.session as { model: string }).model, 'gpt-realtime-2.1');
  });

  it('refuses a replayed attach token', async () => {
    const replay = await fetch(`${baseUrl}/api/voice/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ callId: 'provider-call-smoke', sessionId, epoch, attachToken }),
    });
    assert.equal(replay.status, 409, 'a one-time grant must not attach twice');
  });

  it('sends a final transcript to Hermes server-to-server and speaks only its answer', async () => {
    socket!.emit('message', Buffer.from(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-smoke-1',
      transcript: 'where are we up to',
    })));
    await new Promise((r) => setTimeout(r, 30));

    const chat = hermesCalls.find((call) => call.url.endsWith('/chat'));
    assert.ok(chat, 'the relay must call Hermes session chat');
    assert.equal(
      chat!.url,
      `${testVoiceConfig().hermes.apiUrl}/api/sessions/${testVoiceConfig().hermes.sessionId}/chat`,
      'the exact supported route with the configured stable session mapping',
    );
    const headers = chat!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${testVoiceConfig().hermes.apiKey}`);
    assert.equal(headers[HERMES_SESSION_KEY_HEADER], testVoiceConfig().hermes.sessionKey);
    assert.equal(JSON.parse(String(chat!.init.body)).message, 'where are we up to');

    const create = socket!.sentEvents().find((event) => event.type === 'response.create');
    assert.ok(create, 'the Hermes answer must be rendered as audio');
    const response = create!.response as Record<string, unknown>;
    assert.equal(response.conversation, 'none');
    assert.deepEqual(response.output_modalities, ['audio']);
    assert.match(JSON.stringify(response.input), new RegExp(HERMES_ANSWER));
  });

  it('never returns Hermes credentials or session identity to the browser', async () => {
    const status = await fetch(`${baseUrl}/api/voice/status`, { headers: { cookie } });
    assert.equal(status.status, 200);
    const raw = await status.text();

    const route = testVoiceConfig().hermes;
    for (const secret of [route.apiKey, route.sessionKey, route.sessionId]) {
      assert.doesNotMatch(raw, new RegExp(secret), 'no Hermes identity may reach the browser');
    }
    const body = JSON.parse(raw) as { enabled: boolean; state: string };
    assert.equal(body.enabled, true);
    assert.equal(body.state, 'active');
  });

  it('refuses a provider function call rather than answering it', async () => {
    socket!.emit('message', Buffer.from(JSON.stringify({
      type: 'response.function_call_arguments.done',
      name: 'send_to_session',
      call_id: 'fc-2',
      arguments: JSON.stringify({ text: 'run the tests' }),
    })));
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(
      socket!.sentEvents().some((event) => event.type === 'conversation.item.create'),
      false,
      'the session declares no tools, so no tool output may be written',
    );
    // The refusal ends the session, which is the fail-closed outcome.
    const status = await fetch(`${baseUrl}/api/voice/status`, { headers: { cookie } });
    assert.equal(status.status, 200);
  });

  it('hangs up explicitly and acknowledges the provider hangup', async () => {
    const response = await fetch(`${baseUrl}/api/voice/terminate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ sessionId, epoch, reason: 'client_request' }),
    });
    assert.equal(response.status, 200);

    const body = await response.json() as { state: string; providerHangupConfirmed: boolean };
    assert.ok(['terminated', 'failed'].includes(body.state), `unexpected terminal state ${body.state}`);
    assert.ok(providerCalls.some((u) => u.includes('/hangup')), 'the relay must ask the provider to hang up');

    // A repeat hangup is idempotent, and the lease is gone.
    const repeat = await fetch(`${baseUrl}/api/voice/terminate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ sessionId, epoch, reason: 'client_request' }),
    });
    assert.equal(repeat.status, 200);

    const heartbeat = await fetch(`${baseUrl}/api/voice/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ sessionId, epoch }),
    });
    assert.equal(heartbeat.status, 409, 'a terminated lease must not heartbeat');
  });

  it('made no request to a real provider or Hermes endpoint', () => {
    for (const url of providerCalls) {
      assert.match(url, /^https:\/\/api\.openai\.com\//, 'only provider URLs were constructed');
    }
    for (const call of hermesCalls) {
      assert.match(call.url, /^https:\/\/hermes\.private\.test\//, 'only the configured Hermes route was constructed');
    }
    // Proof of mocking: every call above went through an injected fetch double,
    // so no socket was ever opened to api.openai.com or to a Hermes server.
    assert.ok(providerCalls.length >= 2);
    assert.ok(hermesCalls.length >= 2, 'capabilities certification plus at least one turn');
  });
});
