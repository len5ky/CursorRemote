import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type WebSocket from 'ws';
import { Relay } from '../../src/server/relay.js';
import { VoiceTransport } from '../../src/server/transports/voice/index.js';
import type { CDPBridge } from '../../src/server/cdp-bridge.js';
import type { CommandExecutor } from '../../src/server/command-executor.js';
import type { StateManager } from '../../src/server/state-manager.js';
import type { ServerConfig } from '../../src/server/types.js';
import { FakeHermesConversationReader, FakeRealtimeSocket, testVoiceConfig } from './voice-fixtures.js';

/**
 * Shared relay + mocked-voice-transport harness for route-level tests.
 *
 * Every provider interaction is a double: the injected fetch answers
 * client_secrets and hangup, and the injected socket factory returns
 * FakeRealtimeSocket. Nothing in a suite built on this helper can reach
 * api.openai.com.
 */

export function stubStateManager(): StateManager {
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

export interface VoiceRelayHarnessOptions {
  /** Empty string means "no WEBAPP_PASSWORD configured". */
  password?: string;
  voiceEnabled?: boolean;
  publicOrigin?: string;
  /** Skip attaching a VoiceTransport, to exercise the not-enabled branches. */
  withTransport?: boolean;
  /** HTTP status the fake provider returns for client_secrets. */
  mintStatus?: number;
  /** HTTP status the fake provider returns for /hangup. */
  hangupStatus?: number;
  /** Make the sideband WebSocket factory throw. */
  sidebandFails?: boolean;
  /** Declare the relay as sitting behind the Tailscale Serve proxy. */
  trustTailscaleIdentity?: boolean;
  /** Override the configured price-table version, to exercise admission. */
  priceVersion?: string;
  /** Stable single-operator budget account id. */
  accountId?: string;
}

export interface VoiceRelayHarness {
  baseUrl: string;
  port: number;
  /** Temp directory holding the persisted ledger and session store. */
  dataDir: string;
  relay: Relay;
  transport: VoiceTransport | null;
  providerCalls: string[];
  sockets: FakeRealtimeSocket[];
  login(): Promise<string>;
  /** Raw request so tests can set forbidden-in-fetch headers such as Host. */
  raw(options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}

export async function startVoiceRelay(options: VoiceRelayHarnessOptions = {}): Promise<VoiceRelayHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'voice-relay-harness-'));
  const password = options.password ?? 'harness-password';
  const providerCalls: string[] = [];
  const sockets: FakeRealtimeSocket[] = [];

  const config = {
    cdpUrl: 'http://127.0.0.1:9222',
    serverPort: 0,
    serverHost: '127.0.0.1',
    pollIntervalMs: 300,
    debounceMs: 150,
    selectorsPath: './selectors.json',
    logLevel: 'error',
    webappPassword: password,
    windowTitleQualifier: true,
    dataDir,
    trustTailscaleIdentity: options.trustTailscaleIdentity ?? false,
    telegram: { enabled: false, botToken: '', preRegisteredUsers: [], impl: 'grammy' as const },
    voice: testVoiceConfig({
      enabled: options.voiceEnabled ?? true,
      publicOrigin: options.publicOrigin ?? '',
      ...(options.priceVersion !== undefined ? { usagePriceVersion: options.priceVersion } : {}),
      ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
    }),
  } as unknown as ServerConfig;

  const relay = new Relay(
    config,
    stubStateManager(),
    {} as CommandExecutor,
    { on: () => {}, off: () => {} } as unknown as CDPBridge,
  );

  let transport: VoiceTransport | null = null;
  if (options.withTransport !== false) {
    transport = new VoiceTransport(config.voice, dataDir, new FakeHermesConversationReader(), {
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        providerCalls.push(url);
        if (url.endsWith('/client_secrets')) {
          const status = options.mintStatus ?? 200;
          return status === 200
            ? new Response(JSON.stringify({ value: 'ephemeral-browser-secret', expires_at: 4102444800 }), { status: 200 })
            : new Response('nope', { status });
        }
        if (url.includes('/hangup')) return new Response(null, { status: options.hangupStatus ?? 200 });
        throw new Error(`unexpected provider call: ${url}`);
      }) as typeof fetch,
      websocketFactory: () => {
        if (options.sidebandFails) throw new Error('provider sideband unavailable in tests');
        const socket = new FakeRealtimeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    relay.setVoiceTransport(transport);
  }

  await relay.start();
  const address = (relay as unknown as { httpServer: { address(): AddressInfo } }).httpServer.address();
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const raw: VoiceRelayHarness['raw'] = (opts) => new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: {
          ...(opts.body !== undefined ? { 'Content-Length': Buffer.byteLength(opts.body) } : {}),
          ...(opts.headers ?? {}),
        },
        // setHost:false lets a test supply a hostile Host header verbatim.
        setHost: opts.headers?.Host === undefined && opts.headers?.host === undefined,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => { text += chunk; });
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
      },
    );
    req.on('error', rejectPromise);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });

  return {
    baseUrl,
    port,
    dataDir,
    relay,
    transport,
    providerCalls,
    sockets,
    raw,
    async login(): Promise<string> {
      const response = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (response.status !== 200) throw new Error(`harness login failed: HTTP ${response.status}`);
      return (response.headers.get('set-cookie') ?? '').split(';')[0];
    },
    async close(): Promise<void> {
      if (transport) await transport.stop();
      const httpServer = (relay as unknown as {
        httpServer: { close(cb: () => void): void; closeAllConnections?: () => void };
      }).httpServer;
      // `close()` alone waits for every open socket to drain. A suite that
      // deliberately provokes a stalled request would then hang in teardown
      // instead of reporting the failure it just proved.
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolvePromise) => { httpServer.close(() => resolvePromise()); });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
