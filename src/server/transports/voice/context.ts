import type {
  HermesConversationReader,
  HermesConversationSnapshot,
  HermesReadResult,
  ReadContextLimits,
  SessionSummary,
} from './tools.js';
import {
  VOICE_MAX_CONTEXT_BYTES,
  VOICE_MAX_CONTEXT_TURNS,
} from './constants.js';

const MAX_SESSION_COUNT = 32;
const MAX_TABS_PER_SESSION = 32;
const MAX_TEXT_BYTES = 4_000;
const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/**
 * Production adapter for the documented Hermes read-context endpoint.
 *
 * The endpoint is deliberately explicit: when HERMES_READ_CONTEXT_URL is not
 * configured, this adapter reports unavailable rather than inventing context.
 * The response contract is a JSON object with conversationId, revision,
 * observedAt, agentStatus, sessions, and turns. See the operator guide.
 */
export class HttpHermesConversationReader implements HermesConversationReader {
  constructor(
    private readonly endpoint: string,
    private readonly bearerToken = '',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async readConversation(limits: ReadContextLimits = {}): Promise<HermesReadResult> {
    if (!this.endpoint) {
      return { kind: 'unavailable', reason: 'HERMES_READ_CONTEXT_URL is not configured' };
    }

    let url: URL;
    try {
      url = new URL(this.endpoint);
      if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        return { kind: 'unavailable', reason: 'Hermes read endpoint must use HTTPS or loopback HTTP' };
      }
    } catch {
      return { kind: 'unavailable', reason: 'Hermes read endpoint URL is invalid' };
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { kind: 'unavailable', reason: `Hermes read endpoint returned HTTP ${response.status}` };
      const body: unknown = await response.json();
      return parseSnapshot(body, limits);
    } catch {
      return { kind: 'unavailable', reason: 'Hermes read endpoint could not be reached' };
    }
  }
}

function parseSnapshot(body: unknown, limits: ReadContextLimits): HermesReadResult {
  if (!isRecord(body)) return { kind: 'unavailable', reason: 'Hermes read response was not an object' };
  const conversationId = boundedRequiredString(body.conversationId, 256);
  const revision = boundedRequiredString(body.revision, 256);
  const observedAt = boundedRequiredString(body.observedAt, 128);
  const agentStatus = boundedRequiredString(body.agentStatus, 128);
  if (!conversationId || !revision || !observedAt || !agentStatus) {
    return { kind: 'unavailable', reason: 'Hermes read response was missing required identity fields' };
  }
  if (!Array.isArray(body.sessions) || !Array.isArray(body.turns)) {
    return { kind: 'unavailable', reason: 'Hermes read response did not match the documented schema' };
  }

  const sessions: SessionSummary[] = [];
  for (const item of body.sessions.slice(0, MAX_SESSION_COUNT)) {
    const session = parseSession(item);
    if (!session) return { kind: 'unavailable', reason: 'Hermes read response contained an invalid session' };
    sessions.push(session);
  }

  const turns = [];
  for (const item of body.turns.slice(-Math.min(limits.maxTurns ?? VOICE_MAX_CONTEXT_TURNS, VOICE_MAX_CONTEXT_TURNS))) {
    if (!isRecord(item) || typeof item.role !== 'string' || !VALID_ROLES.has(item.role)) {
      return { kind: 'unavailable', reason: 'Hermes read response contained an invalid turn' };
    }
    const content = boundedRequiredString(item.content, MAX_TEXT_BYTES);
    if (!content) return { kind: 'unavailable', reason: 'Hermes read response contained an invalid turn body' };
    turns.push({
      role: item.role as 'user' | 'assistant' | 'system' | 'tool',
      content,
      ...(typeof item.observedAt === 'string' ? { observedAt: item.observedAt.slice(0, 128) } : {}),
    });
  }

  const snapshot: HermesConversationSnapshot = {
    conversationId,
    revision,
    observedAt,
    agentStatus,
    sessions,
    turns,
  };
  const maxBytes = Math.max(1_000, Math.min(limits.maxBytes ?? VOICE_MAX_CONTEXT_BYTES, VOICE_MAX_CONTEXT_BYTES));
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    snapshot.turns = trimTurnsToBytes(snapshot.turns, maxBytes, snapshot);
  }
  return { kind: 'available', snapshot };
}

function parseSession(value: unknown): SessionSummary | null {
  if (!isRecord(value)) return null;
  const id = boundedRequiredString(value.id, 256);
  const title = boundedRequiredString(value.title, 256);
  const status = boundedRequiredString(value.status, 128);
  if (!id || !title || !status || !Array.isArray(value.tabs)) return null;
  const tabs = value.tabs.slice(0, MAX_TABS_PER_SESSION).map((tab) => {
    if (!isRecord(tab) || typeof tab.title !== 'string' || typeof tab.isActive !== 'boolean' || typeof tab.status !== 'string') return null;
    return { title: tab.title.slice(0, 256), isActive: tab.isActive, status: tab.status.slice(0, 128) };
  });
  return tabs.every(Boolean) ? { id, title, status, tabs: tabs as SessionSummary['tabs'] } : null;
}

function trimTurnsToBytes(
  turns: HermesConversationSnapshot['turns'],
  maxBytes: number,
  snapshot: HermesConversationSnapshot,
): HermesConversationSnapshot['turns'] {
  const kept: HermesConversationSnapshot['turns'] = [];
  for (const turn of turns.slice(-VOICE_MAX_CONTEXT_TURNS).reverse()) {
    const candidate = [turn, ...kept];
    if (Buffer.byteLength(JSON.stringify({ ...snapshot, turns: candidate }), 'utf8') > maxBytes) break;
    kept.unshift(turn);
  }
  return kept;
}

function boundedRequiredString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const valueBytes = Buffer.byteLength(value, 'utf8');
  if (valueBytes > maxBytes) return value.slice(0, maxBytes);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
