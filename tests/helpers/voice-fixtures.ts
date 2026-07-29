import type { VoiceConfig } from '../../src/server/types.js';
import { KNOWN_VOICE_PRICE_VERSION } from '../../src/server/transports/voice/pricing.js';
import {
  HERMES_CAPABILITIES_PATH,
  HERMES_TOOLSETS_PATH,
  HermesPolicyResult,
  HermesTurnResult,
  VoiceHermesAgent,
} from '../../src/server/transports/voice/hermes-chat.js';

/**
 * Deterministic stand-in for the *only* conversational authority: the private
 * Hermes deployment reached server-to-server over session chat.
 *
 * This lives under tests/ on purpose. Production startup wires
 * HermesSessionChatClient against explicitly configured, server-only route
 * values and fails closed when they are absent; it must never be able to select
 * this class, because a fixture that looks live is worse than an honest failure.
 */
export class FakeHermesAgent implements VoiceHermesAgent {
  /** Every transcript the relay actually submitted, in order. */
  readonly sent: string[] = [];
  /** The abort signal handed to each in-flight turn, in order. */
  readonly signals: AbortSignal[] = [];
  policyCalls = 0;

  constructor(
    private readonly script: {
      reply?: (transcript: string, index: number) => HermesTurnResult;
      delayMs?: (index: number) => number;
      policy?: HermesPolicyResult;
    } = {},
  ) {}

  async send(transcript: string, options: { signal: AbortSignal }): Promise<HermesTurnResult> {
    const index = this.sent.length;
    this.sent.push(transcript);
    this.signals.push(options.signal);
    const delayMs = this.script.delayMs?.(index) ?? 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (options.signal.aborted) return { kind: 'error', reason: 'aborted' };
    return this.script.reply?.(transcript, index)
      ?? { kind: 'ok', assistantText: `hermes answer ${index + 1}` };
  }

  async verifyPolicy(): Promise<HermesPolicyResult> {
    this.policyCalls += 1;
    return this.script.policy ?? { ok: true };
  }
}

/** A correctly locked-down documented Hermes `/v1/capabilities` report. */
export function hermesCapabilities(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'hermes.api_server.capabilities',
    platform: 'hermes-agent',
    model: 'hermes-agent',
    auth: { type: 'bearer', required: true },
    runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
    features: { session_chat: true, skills_api: true },
    endpoints: {
      toolsets: { method: 'GET', path: HERMES_TOOLSETS_PATH },
    },
    ...overrides,
  };
}

/** A correctly locked-down documented Hermes `/v1/toolsets` report. */
export function hermesToolsets(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'list',
    platform: 'api_server',
    data: [],
    ...overrides,
  };
}

/**
 * Minimal stand-in for the provider sideband WebSocket. Records what the relay
 * sends and lets a test push provider events back, with no network access.
 */
export class FakeRealtimeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, (value?: unknown) => void>();

  /**
   * @param autoOpen `false` models a socket that never reaches OPEN — the
   * provider accepted the TCP connection and then closed, or the handshake was
   * refused. The attach promise has to settle on that path too.
   */
  constructor(private readonly autoOpen = true) {
    if (!autoOpen) this.readyState = 0;
  }

  on(event: string, handler: (value?: unknown) => void): this {
    this.handlers.set(event, handler);
    if (event === 'open' && this.autoOpen) queueMicrotask(() => handler());
    return this;
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.handlers.get('close')?.();
  }

  /** Push a provider event into the relay's sideband handler. */
  emit(event: string, value?: unknown): void {
    this.handlers.get(event)?.(value);
  }

  /** Every JSON event the relay sent to the provider. */
  sentEvents(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

/** Canonical VoiceConfig for tests. There is deliberately no model field. */
export function testVoiceConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    enabled: true,
    openaiApiKey: 'server-key-for-test',
    publicOrigin: '',
    // Server-only Hermes route. Never returned to the browser, never logged.
    hermes: {
      apiUrl: 'https://hermes.private.test',
      apiKey: 'herme...st',
      sessionId: 'hermes-session-configured',
      sessionKey: 'hermes-session-key-for-test',
      capabilitiesPath: HERMES_CAPABILITIES_PATH,
      toolsetsPath: HERMES_TOOLSETS_PATH,
      policyTimeoutMs: 10_000,
    },
    voice: 'marin',
    accountId: 'test-operator',
    // A real entry from the frozen price table: admission requires a *known*
    // version, so a made-up fixture string would deny every test session.
    usagePriceVersion: KNOWN_VOICE_PRICE_VERSION,
    usageUnitPriceCentsPerMinute: 1,
    usageDailyCapCents: 100,
    usagePerSessionCapCents: 10,
    sessionAbsoluteMs: 600_000,
    sessionIdleMs: 60_000,
    sessionIdleGraceMs: 5_000,
    sessionLeaseMs: 30_000,
    ...overrides,
  };
}

/**
 * Every tool name the pre-V1 mutation-capable voice surface exposed. Voice must
 * deny all of them without reaching a mutator, and without dropping the sideband.
 */
export const LEGACY_MUTATION_TOOL_NAMES = [
  'set_target',
  'send_to_session',
  'approve',
  'reject',
  'approve_all',
  'run_action',
  'skip_action',
  'set_mode',
  'set_model',
  'cancel',
  'retry',
  'resume',
  'confirm_pending',
  'defer_pending',
  'new_chat',
  'run_terminal',
  'read_file',
  'write_file',
] as const;
