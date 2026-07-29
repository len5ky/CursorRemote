import type { VoiceSessionContext } from './session.js';
import {
  VOICE_MAX_CONTEXT_BYTES,
  VOICE_MAX_CONTEXT_TURNS,
  VOICE_MAX_TOOL_OUTPUT_BYTES,
} from './constants.js';

export interface SessionSummary {
  id: string;
  title: string;
  status: string;
  tabs: { title: string; isActive: boolean; status: string }[];
}

export type HermesTurnRole = 'user' | 'assistant' | 'system' | 'tool';

export interface HermesConversationTurn {
  role: HermesTurnRole;
  content: string;
  observedAt?: string;
}

export interface HermesConversationSnapshot {
  conversationId: string;
  revision: string;
  observedAt: string;
  agentStatus: string;
  sessions: SessionSummary[];
  turns: HermesConversationTurn[];
}

export type HermesReadResult =
  | { kind: 'available'; snapshot: HermesConversationSnapshot }
  | { kind: 'unavailable'; reason: string };

export interface ReadContextLimits {
  maxTurns?: number;
  maxBytes?: number;
}

/** Production/test boundary for genuine, read-only Hermes conversation context. */
export interface HermesConversationReader {
  readConversation(limits?: ReadContextLimits): Promise<HermesReadResult>;
}

/**
 * V1 dependency surface. It contains only a read-only Hermes reader and the
 * dedicated transport disconnect control; no command executor or write callback
 * can be injected into the voice router.
 */
export interface VoiceToolDeps {
  contextReader: HermesConversationReader;
  terminateVoice?: (context: VoiceSessionContext) => Promise<{ state: string }>;
}

export interface VoiceToolAuthority {
  accepts(context: VoiceSessionContext): boolean;
  live(context: VoiceSessionContext): boolean;
}

/** JSON tool schemas for the Realtime session config. */
export const VOICE_TOOL_SCHEMAS = [
  {
    type: 'function',
    name: 'list_sessions',
    description: 'List the currently connected Hermes contexts and their tabs. Read-only.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'get_status',
    description: 'Give a short spoken read-only status of the current Hermes context.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'get_all_status',
    description: 'Give a short spoken read-only status of every connected context.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'read_recent',
    description: 'Summarize recent read-only Hermes conversation context in spoken form.',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number', description: 'How many recent items to include, default 6' } },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'disconnect_voice',
    description: 'End this voice session immediately. This is transport control, not a Hermes action.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
] as const;

export type VoiceToolResultKind =
  | 'ok'
  | 'read_only_denied'
  | 'context_unavailable'
  | 'stale_session'
  | 'budget_blocked'
  | 'invalid_request';

export interface ToolResult {
  kind: VoiceToolResultKind;
  ok: boolean;
  output: string;
}

const READ_ONLY_DENIAL = 'Voice V1 is read-only; this request is unavailable.';

export class VoiceToolRouter {
  constructor(
    private readonly deps: VoiceToolDeps,
    private readonly authority?: VoiceToolAuthority,
  ) {}

  async call(name: string, args: Record<string, unknown>, context?: VoiceSessionContext): Promise<ToolResult> {
    if (context && this.authority && !this.authority.accepts(context)) {
      return this.result('stale_session', 'Voice session is no longer live.');
    }

    switch (name) {
      case 'list_sessions':
        return this.listSessions();
      case 'get_status':
        return this.getStatus();
      case 'get_all_status':
        return this.getAllStatus();
      case 'read_recent':
        return this.readRecent(args);
      case 'disconnect_voice':
        return this.disconnectVoice(context);
      default:
        // Fail closed. Legacy mutation names and unknown names are
        // indistinguishable here because neither has a dispatch path at all —
        // there is no mutator on VoiceToolDeps for either to reach.
        return this.result('read_only_denied', READ_ONLY_DENIAL);
    }
  }

  private async listSessions(): Promise<ToolResult> {
    const read = await this.deps.contextReader.readConversation({ maxTurns: 0, maxBytes: 4_000 });
    if (read.kind === 'unavailable') return this.unavailable(read.reason);
    if (read.snapshot.sessions.length === 0) return this.result('ok', 'No connected Hermes contexts are available right now.');
    const lines = read.snapshot.sessions.map((session) => {
      const tabs = session.tabs
        .map((tab) => `${tab.title}${tab.isActive ? ' (active)' : ''}`)
        .join(', ') || 'no tabs';
      return `${session.title}: ${session.status}; ${tabs}`;
    });
    return this.result('ok', lines.join('. '));
  }

  private async getStatus(): Promise<ToolResult> {
    const read = await this.deps.contextReader.readConversation({ maxTurns: 0, maxBytes: 2_000 });
    if (read.kind === 'unavailable') return this.unavailable(read.reason);
    return this.result('ok', `Hermes context ${read.snapshot.conversationId} is ${read.snapshot.agentStatus}.`);
  }

  private async getAllStatus(): Promise<ToolResult> {
    const read = await this.deps.contextReader.readConversation({ maxTurns: 0, maxBytes: 4_000 });
    if (read.kind === 'unavailable') return this.unavailable(read.reason);
    if (read.snapshot.sessions.length === 0) return this.result('ok', 'No connected Hermes contexts are available right now.');
    return this.result('ok', read.snapshot.sessions.map((session) => `${session.title}: ${session.status}`).join('. '));
  }

  private async readRecent(args: Record<string, unknown>): Promise<ToolResult> {
    const rawCount = args.count;
    if (rawCount !== undefined && (typeof rawCount !== 'number' || !Number.isFinite(rawCount))) {
      return this.result('invalid_request', 'The recent-context count must be a finite number.');
    }
    const requested = rawCount === undefined ? 6 : Math.floor(rawCount);
    if (requested < 1 || requested > VOICE_MAX_CONTEXT_TURNS) {
      return this.result('invalid_request', `The recent-context count must be between 1 and ${VOICE_MAX_CONTEXT_TURNS}.`);
    }
    const read = await this.deps.contextReader.readConversation({
      maxTurns: requested,
      maxBytes: VOICE_MAX_CONTEXT_BYTES,
    });
    if (read.kind === 'unavailable') return this.unavailable(read.reason);
    if (read.snapshot.turns.length === 0) return this.result('ok', 'No recent Hermes conversation context is available.');
    const lines = read.snapshot.turns.slice(-requested).map((turn) => `${turn.role}: ${turn.content}`);
    return this.result('ok', lines.join('\n'));
  }

  private async disconnectVoice(context?: VoiceSessionContext): Promise<ToolResult> {
    if (this.authority && (!context || !this.authority.live(context))) {
      return this.result('stale_session', 'Voice session is no longer live.');
    }
    if (!this.deps.terminateVoice || !context) {
      return this.result('invalid_request', 'Voice termination is unavailable.');
    }
    // A bare await let a failing termination reject out of the router. The
    // sideband's catch-all swallowed it, so no function_call_output was ever
    // sent and the model sat waiting on a tool result that would never come.
    // The failure is answered generically instead; the cause is logged
    // server-side, because the model may repeat aloud whatever it is told.
    try {
      const status = await this.deps.terminateVoice(context);
      return this.result('ok', `Voice session ${status.state}.`);
    } catch (err) {
      console.error(`[voice] Tool-initiated termination failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      return this.result('invalid_request', 'Voice termination is unavailable.');
    }
  }

  /**
   * Context could not be read. The model is told the honest fact — the context
   * is unavailable, so it must not pretend otherwise — but not *why*: the
   * reason names env vars, endpoints and upstream statuses, and anything the
   * model is told it may say out loud to whoever is on the call.
   */
  private unavailable(reason: string): ToolResult {
    console.warn(`[voice] Hermes context unavailable: ${reason}`);
    return this.result('context_unavailable', 'Live Hermes context is unavailable right now.');
  }

  private result(kind: VoiceToolResultKind, output: string): ToolResult {
    return { kind, ok: kind === 'ok', output: truncateUtf8(output, VOICE_MAX_TOOL_OUTPUT_BYTES) };
  }
}

/**
 * Cut a string to a UTF-8 *byte* ceiling without splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a cap written as
 * `slice(0, N)` let N characters of non-ASCII context weigh up to 3N bytes
 * (4N with astral characters) on the wire — the ceiling the provider and the
 * sideband are sized against was silently blown by any non-English reply.
 * Rewinding off continuation bytes keeps the result decodable: a tool output
 * ending in half a character is not something the model can read back.
 *
 * Exported because every other byte cap on this surface — context identity
 * fields, session metadata, turn bodies, the function name and call id echoed
 * back to the provider — has exactly the same problem and must be cut the same
 * way. A second, hand-rolled copy is how one of them drifts back to `slice`.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  // 0b10xxxxxx is a continuation byte, so the cut landed mid-character.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.toString('utf8', 0, end);
}
