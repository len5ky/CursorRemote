import { createHash } from 'crypto';
import WebSocket, { type ClientOptions } from 'ws';
import type { VoiceConfig } from '../../types.js';
import type { VoiceToolRouter } from './tools.js';
import { VOICE_TOOL_SCHEMAS } from './tools.js';
import { VOICE_MAX_TOOL_ARGUMENT_BYTES, VOICE_REALTIME_MODEL } from './constants.js';
import type { VoiceSessionContext } from './session.js';

/**
 * DICKTATOR Realtime bridge — OpenAI Realtime API (GA interface) session management.
 *
 * Flow (preferred, ephemeral-token pattern):
 *  1. Browser asks the relay for a client secret → mintClientSecret() POSTs
 *     to /v1/realtime/client_secrets with the real API key (server-side only).
 *  2. Browser opens a WebRTC session directly to OpenAI at /v1/realtime/calls
 *     using the ephemeral token; audio never transits our server.
 *  3. Browser reports only call_id back to the relay → attachSideband() opens
 *     wss://api.openai.com/v1/realtime?call_id=… using the server-held standard
 *     project key. The browser secret never crosses back through the relay.
 *
 * The model only ever sees the closed tool set from tools.ts.
 */

const OPENAI_BASE = 'https://api.openai.com/v1/realtime';
const OPENAI_WS_BASE = 'wss://api.openai.com/v1/realtime';
const HANGUP_ATTEMPTS = 3;
const HANGUP_RETRY_DELAY_MS = 100;

export const VOICE_INSTRUCTIONS =
  'You are a private read-only voice companion for the current Hermes context. ' +
  'Keep replies to one or two short natural sentences; no lists, code, file paths, hashes, URLs, or shell commands. ' +
  'You may answer conversationally and use the read-only context tools for status and recent context. ' +
  'Never send messages, approve or reject actions, run tools, switch targets, change modes or models, or confirm mutations. ' +
  'If the user asks for an action, clearly say that this voice surface is read-only and cannot perform it. ' +
  'The disconnect_voice tool only ends the current voice call.';

export interface ClientSecretResult {
  clientSecret: string;
  expiresAt?: number;
}

export interface RealtimeBridgeOptions {
  fetchImpl?: typeof fetch;
  websocketFactory?: (url: string, options: ClientOptions) => WebSocket;
}

/** Stable, privacy-safe identifier sent to OpenAI; the raw account key never leaves the relay. */
export function safetyIdentifierForAccount(accountKey: string): string {
  return createHash('sha256').update(accountKey).digest('hex');
}

/** Extract the provider call id from the standard Location response header. */
export function extractCallId(headers: Headers | { get(name: string): string | null }): string | null {
  const location = headers.get('location');
  if (!location) return null;
  const match = location.match(/\/calls\/([^/?#]+)(?:[/?#]|$)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export interface RealtimeBridgeAuthority {
  accepts(context: VoiceSessionContext): boolean;
  userTurn(context: VoiceSessionContext): void;
  providerFailure(context: VoiceSessionContext, reason: string): void;
  reportSpend(context: VoiceSessionContext, cents: number, source: 'estimated' | 'reported'): boolean;
}

export function parseUsageFromDone(raw: string): { reportedCents?: number; audioDurationMs?: number } | null {
  let event: { type?: string; response?: { usage?: { cost_cents?: number; total_cost_cents?: number; cost?: { cents?: number }; output_tokens?: { audio_duration_ms?: number; text_duration_ms?: number } } } };
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (event.type !== 'response.done') return null;
  const usage = event.response?.usage;
  if (!usage) return null;
  const audioDurationMs = usage.output_tokens?.audio_duration_ms;
  const cents = usage.cost_cents ?? usage.total_cost_cents ?? usage.cost?.cents;
  const result: { reportedCents?: number; audioDurationMs?: number } = {};
  // Only provider-supplied cents are reported; duration priced locally remains an estimate.
  if (typeof cents === 'number' && Number.isFinite(cents) && cents >= 0) result.reportedCents = cents;
  if (typeof audioDurationMs === 'number' && Number.isFinite(audioDurationMs) && audioDurationMs > 0) result.audioDurationMs = audioDurationMs;
  return result.reportedCents === undefined && result.audioDurationMs === undefined ? null : result;
}

export function buildSessionConfig(config: VoiceConfig): Record<string, unknown> {
  return {
    session: {
      type: 'realtime',
      model: VOICE_REALTIME_MODEL,
      instructions: VOICE_INSTRUCTIONS,
      audio: {
        input: { turn_detection: { type: 'server_vad' } },
        output: { voice: config.voice },
      },
      tools: VOICE_TOOL_SCHEMAS,
      tool_choice: 'auto',
      // Keep latency low for conversational driving use.
      reasoning: { effort: 'low' },
    },
  };
}

export class RealtimeBridge {
  private config: VoiceConfig;
  private router: VoiceToolRouter;
  private authority: RealtimeBridgeAuthority;
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private context: VoiceSessionContext | null = null;
  private readonly closedByUs = new WeakSet<WebSocket>();
  private readonly fetchImpl: typeof fetch;
  private readonly websocketFactory: (url: string, options: ClientOptions) => WebSocket;

  constructor(config: VoiceConfig, router: VoiceToolRouter, authority: RealtimeBridgeAuthority, options: RealtimeBridgeOptions = {}) {
    this.config = config;
    this.router = router;
    this.authority = authority;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.websocketFactory = options.websocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connectedFor(context: VoiceSessionContext): boolean {
    return this.connected && this.sameContext(context, this.context);
  }

  /** Mint an ephemeral client secret so the browser can connect via WebRTC. */
  async mintClientSecret(accountKey: string): Promise<ClientSecretResult> {
    if (!this.config.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');
    const resp = await this.fetchImpl(`${OPENAI_BASE}/client_secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...buildSessionConfig(this.config),
        safety_identifier: safetyIdentifierForAccount(accountKey),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      throw new Error(`client_secrets failed: HTTP ${resp.status}`);
    }
    const data = await resp.json() as { value?: string; client_secret?: { value?: string }; expires_at?: number };
    const value = data.value ?? data.client_secret?.value;
    if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
      throw new Error('client_secrets response missing secret value');
    }
    return { clientSecret: value, expiresAt: data.expires_at };
  }

  /**
   * Attach a server-side sideband WebSocket to a browser-initiated WebRTC call.
   * All function calls are handled here (server-authoritative), so the browser
   * client stays dumb.
   */
  attachSideband(callId: string, context: VoiceSessionContext): Promise<void> {
    this.detach();
    this.callId = callId;
    this.context = context;

    if (!this.config.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');

    return new Promise((resolve, reject) => {
      const ws = this.websocketFactory(`${OPENAI_WS_BASE}?call_id=${encodeURIComponent(callId)}`, {
        headers: { Authorization: `Bearer ${this.config.openaiApiKey}` },
        maxPayload: 16 * 1024,
      });
      this.ws = ws;

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Sideband WS connect timeout'));
        this.authority.providerFailure(context, 'sideband_connect_timeout');
        this.closedByUs.add(ws);
        try { ws.close(); } catch { /* ok */ }
      }, 15_000);

      ws.on('open', () => {
        clearTimeout(timer);
        settled = true;
        console.log(`[dicktator] Sideband attached (call ${callId.substring(0, 12)}...)`);
        resolve();
      });
      ws.on('message', (raw) => {
        if (!this.authority.accepts(context)) return;
        void this.onServerEvent(raw.toString(), context).catch(() =>
          console.error('[voice] Sideband event handling failed')
        );
      });
      ws.on('error', () => {
        clearTimeout(timer);
        console.error('[voice] Sideband WebSocket error');
        if (!settled) {
          settled = true;
          reject(new Error('Sideband WebSocket connection failed'));
        }
        if (!this.closedByUs.has(ws)) this.authority.providerFailure(context, 'sideband_error');
      });
      ws.on('close', () => {
        if (!this.closedByUs.has(ws)) {
          console.log('[dicktator] Sideband WS closed');
          this.authority.providerFailure(context, 'sideband_closed');
        }
        if (this.ws === ws) this.ws = null;
      });
    });
  }

  detach(context?: VoiceSessionContext): string | null {
    if (context && !this.sameContext(context, this.context)) return null;
    const callId = this.callId;
    if (this.ws) {
      this.closedByUs.add(this.ws);
      try { this.ws.close(); } catch { /* ok */ }
      this.ws = null;
    }
    this.callId = null;
    this.context = null;
    return callId;
  }

  async hangup(callId: string): Promise<boolean> {
    if (!this.config.openaiApiKey) return false;
    for (let attempt = 0; attempt < HANGUP_ATTEMPTS; attempt++) {
      try {
        const response = await this.fetchImpl(`${OPENAI_BASE}/calls/${encodeURIComponent(callId)}/hangup`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.config.openaiApiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) return true;
      } catch {
        // Retry transient network and timeout failures.
      }
      if (attempt + 1 < HANGUP_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, HANGUP_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    return false;
  }

  private send(event: Record<string, unknown>, context?: VoiceSessionContext): void {
    if (context ? !this.connectedFor(context) : !this.connected) return;
    this.ws!.send(JSON.stringify(event));
  }

  /**
   * Push a proactive notification into the conversation and ask the model to
   * speak. Used for new pendingApprovals / blocked agents.
   */
  announce(text: string, context: VoiceSessionContext): void {
    if (!this.connectedFor(context)) return;
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: `[proactive notification — briefly tell the user] ${text.slice(0, 240)}` }],
      },
    }, context);
    this.send({ type: 'response.create' }, context);
  }

  private async onServerEvent(raw: string, context: VoiceSessionContext): Promise<void> {
    if (raw.length > 32_768 || !this.authority.accepts(context)) return;
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    switch (event.type) {
      case 'session.created': {
        // Re-assert tools/instructions on the sideband in case the ephemeral
        // session config was minimal.
          this.send({ type: 'session.update', ...buildSessionConfig(this.config) }, context);
        break;
      }
      case 'response.function_call_arguments.done': {
        const name = typeof event.name === 'string' ? event.name.slice(0, 128) : '';
        const functionCallId = typeof event.call_id === 'string' ? event.call_id.slice(0, 256) : '';
        const rawArgs = typeof event.arguments === 'string' ? event.arguments : '{}';
        if (!name || !functionCallId || rawArgs.length > VOICE_MAX_TOOL_ARGUMENT_BYTES) {
          this.send({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: functionCallId, output: 'Invalid or oversized voice tool request.' },
          }, context);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawArgs);
        } catch {
          this.send({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: functionCallId, output: 'Invalid voice tool arguments.' },
          }, context);
          return;
        }
        if (!isRecord(parsed)) {
          this.send({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: functionCallId, output: 'Voice tool arguments must be an object.' },
          }, context);
          return;
        }
        const result = await this.router.call(name, parsed, context);
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: functionCallId,
            output: result.output,
          },
        }, context);
        this.send({ type: 'response.create' }, context);
        break;
      }
      case 'input_audio_buffer.committed':
        this.authority.userTurn(context);
        break;
      case 'response.done': {
        const usage = parseUsageFromDone(raw);
        if (usage?.reportedCents !== undefined) {
          this.authority.reportSpend(context, usage.reportedCents, 'reported');
        } else if (usage?.audioDurationMs !== undefined && Number.isFinite(this.config.usageUnitPriceCentsPerMinute) && this.config.usageUnitPriceCentsPerMinute > 0) {
          const cents = Math.ceil(usage.audioDurationMs * this.config.usageUnitPriceCentsPerMinute / 60_000);
          if (cents > 0) this.authority.reportSpend(context, cents, 'estimated');
        }
        break;
      }
      case 'error': {
        // Provider error bodies can contain request metadata; keep logs coarse.
        console.warn('[voice] Provider realtime error event received');
        break;
      }
      default:
        break;
    }
  }

  private sameContext(a: VoiceSessionContext | null, b: VoiceSessionContext | null): boolean {
    return a?.sessionId === b?.sessionId && a?.epoch === b?.epoch && a?.leaseId === b?.leaseId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
