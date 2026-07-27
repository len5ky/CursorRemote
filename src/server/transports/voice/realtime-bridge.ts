import WebSocket from 'ws';
import type { VoiceConfig } from '../../types.js';
import type { VoiceToolRouter } from './tools.js';
import { VOICE_TOOL_SCHEMAS } from './tools.js';

/**
 * DICKTATOR Realtime bridge — OpenAI Realtime API (GA interface) session management.
 *
 * Flow (preferred, ephemeral-token pattern):
 *  1. Browser asks the relay for a client secret → mintClientSecret() POSTs
 *     to /v1/realtime/client_secrets with the real API key (server-side only).
 *  2. Browser opens a WebRTC session directly to OpenAI at /v1/realtime/calls
 *     using the ephemeral token; audio never transits our server.
 *  3. Browser reports the resulting call_id back to the relay → attachSideband()
 *     opens a server-side WebSocket to wss://api.openai.com/v1/realtime?call_id=…
 *     which handles all tool calls and pushes proactive conversation items.
 *
 * The model only ever sees the closed tool set from tools.ts.
 */

const OPENAI_BASE = 'https://api.openai.com/v1/realtime';
const OPENAI_WS_BASE = 'wss://api.openai.com/v1/realtime';

export const VOICE_INSTRUCTIONS =
  'You are the voice controller for Cursor coding agent sessions ("car mode"). ' +
  'The user is likely driving: keep replies to one or two short sentences, no lists, no code. ' +
  'Never read file paths, hashes, code identifiers, or shell commands aloud. ' +
  'Informational tools run immediately. Mutating tools return a PENDING CONFIRMATION with a token: ' +
  'you MUST read the action back to the user, wait for a clear yes, then call confirm_pending with the token. ' +
  'If the user declines, do not call confirm_pending. ' +
  'If no target session is set, ask which project to target and use set_target.';

export interface ClientSecretResult {
  value: string;
  expiresAt?: number;
}

export function buildSessionConfig(config: VoiceConfig): Record<string, unknown> {
  return {
    session: {
      type: 'realtime',
      model: config.model,
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
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private closedByUs = false;

  constructor(config: VoiceConfig, router: VoiceToolRouter) {
    this.config = config;
    this.router = router;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Mint an ephemeral client secret so the browser can connect via WebRTC. */
  async mintClientSecret(): Promise<ClientSecretResult> {
    if (!this.config.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');
    const resp = await fetch(`${OPENAI_BASE}/client_secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildSessionConfig(this.config)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`client_secrets failed: HTTP ${resp.status} ${body.substring(0, 300)}`);
    }
    const data = await resp.json() as { value?: string; client_secret?: { value?: string }; expires_at?: number };
    const value = data.value ?? data.client_secret?.value;
    if (!value) throw new Error('client_secrets response missing secret value');
    return { value, expiresAt: data.expires_at };
  }

  /**
   * Attach a server-side sideband WebSocket to a browser-initiated WebRTC call.
   * All function calls are handled here (server-authoritative), so the browser
   * client stays dumb.
   */
  attachSideband(callId: string): Promise<void> {
    this.detach();
    this.callId = callId;
    this.closedByUs = false;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${OPENAI_WS_BASE}?call_id=${encodeURIComponent(callId)}`, {
        headers: { Authorization: `Bearer ${this.config.openaiApiKey}` },
      });
      this.ws = ws;

      const timer = setTimeout(() => {
        reject(new Error('Sideband WS connect timeout'));
        try { ws.close(); } catch { /* ok */ }
      }, 15_000);

      ws.on('open', () => {
        clearTimeout(timer);
        console.log(`[dicktator] Sideband attached (call ${callId.substring(0, 12)}...)`);
        resolve();
      });
      ws.on('message', (raw) => {
        this.onServerEvent(raw.toString()).catch(err =>
          console.error(`[dicktator] Event handling error: ${err instanceof Error ? err.message : err}`)
        );
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        console.error(`[dicktator] Sideband WS error: ${err.message}`);
        reject(err);
      });
      ws.on('close', () => {
        if (!this.closedByUs) console.log('[dicktator] Sideband WS closed');
        if (this.ws === ws) this.ws = null;
      });
    });
  }

  detach(): void {
    if (this.ws) {
      this.closedByUs = true;
      try { this.ws.close(); } catch { /* ok */ }
      this.ws = null;
    }
    this.callId = null;
  }

  private send(event: Record<string, unknown>): void {
    if (!this.connected) return;
    this.ws!.send(JSON.stringify(event));
  }

  /**
   * Push a proactive notification into the conversation and ask the model to
   * speak. Used for new pendingApprovals / blocked agents.
   */
  announce(text: string): void {
    if (!this.connected) return;
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: `[proactive notification — briefly tell the user] ${text}` }],
      },
    });
    this.send({ type: 'response.create' });
  }

  private async onServerEvent(raw: string): Promise<void> {
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
        this.send({ type: 'session.update', ...buildSessionConfig(this.config) });
        break;
      }
      case 'response.function_call_arguments.done': {
        const name = String(event.name ?? '');
        const callId = String(event.call_id ?? '');
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(String(event.arguments ?? '{}'));
        } catch { /* keep {} */ }
        console.log(`[dicktator] Tool call: ${name}`);
        const result = await this.router.call(name, args);
        this.send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output: result.output,
          },
        });
        this.send({ type: 'response.create' });
        break;
      }
      case 'error': {
        const err = event.error as { message?: string } | undefined;
        console.warn(`[dicktator] Realtime error event: ${err?.message ?? raw.substring(0, 200)}`);
        break;
      }
      default:
        break;
    }
  }
}
