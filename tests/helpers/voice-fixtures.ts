import type { VoiceConfig } from '../../src/server/types.js';
import { KNOWN_VOICE_PRICE_VERSION } from '../../src/server/transports/voice/pricing.js';
import type {
  HermesConversationReader,
  HermesConversationSnapshot,
  HermesReadResult,
  ReadContextLimits,
} from '../../src/server/transports/voice/tools.js';

/**
 * Deterministic Hermes reader for tests only.
 *
 * This lives under tests/ on purpose. Production startup wires
 * HttpHermesConversationReader and reports `unavailable` when no Hermes read
 * endpoint is configured; it must never be able to select this class, because
 * a fixture that looks live is worse than an honest failure.
 */
export class FakeHermesConversationReader implements HermesConversationReader {
  readonly calls: ReadContextLimits[] = [];

  constructor(
    private readonly result: HermesReadResult = {
      kind: 'available',
      snapshot: FakeHermesConversationReader.snapshot(),
    },
  ) {}

  static snapshot(overrides: Partial<HermesConversationSnapshot> = {}): HermesConversationSnapshot {
    return {
      conversationId: 'hermes-conversation-1',
      revision: 'rev-42',
      observedAt: '2026-07-29T00:00:00.000Z',
      agentStatus: 'idle',
      sessions: [{
        id: 'hermes-1',
        title: 'Hermes',
        status: 'idle',
        tabs: [{ title: 'Current context', isActive: true, status: 'idle' }],
      }],
      turns: [
        { role: 'user', content: 'where are we up to' },
        { role: 'assistant', content: 'the migration is finished' },
      ],
      ...overrides,
    };
  }

  static unavailable(reason = 'no live Hermes endpoint configured'): FakeHermesConversationReader {
    return new FakeHermesConversationReader({ kind: 'unavailable', reason });
  }

  async readConversation(limits: ReadContextLimits = {}): Promise<HermesReadResult> {
    this.calls.push(limits);
    return this.result;
  }
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
    hermesReadContextUrl: '',
    hermesReadContextToken: '',
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
