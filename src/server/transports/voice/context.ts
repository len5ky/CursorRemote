import type {
  HermesConversationReader,
  HermesConversationSnapshot,
  HermesReadResult,
  ReadContextLimits,
  SessionSummary,
} from './tools.js';
import { truncateUtf8 } from './tools.js';
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

  const turnBudget = resolveTurnBudget(limits.maxTurns);
  const turns = [];
  // `slice(-0)` is `slice(0)`, so a zero budget must not reach slice at all.
  for (const item of turnBudget === 0 ? [] : body.turns.slice(-turnBudget)) {
    if (!isRecord(item) || typeof item.role !== 'string' || !VALID_ROLES.has(item.role)) {
      return { kind: 'unavailable', reason: 'Hermes read response contained an invalid turn' };
    }
    const content = boundedRequiredString(item.content, MAX_TEXT_BYTES);
    if (!content) return { kind: 'unavailable', reason: 'Hermes read response contained an invalid turn body' };
    turns.push({
      role: item.role as 'user' | 'assistant' | 'system' | 'tool',
      content,
      ...(typeof item.observedAt === 'string' ? { observedAt: truncateUtf8(item.observedAt, 128) } : {}),
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
  const requestedMaxBytes = limits.maxBytes;
  const maxBytes = requestedMaxBytes === undefined
    ? VOICE_MAX_CONTEXT_BYTES
    : Number.isFinite(requestedMaxBytes)
      ? Math.max(0, Math.min(Math.floor(requestedMaxBytes), VOICE_MAX_CONTEXT_BYTES))
      : 0;
  if (!fitSnapshotToBytes(snapshot, maxBytes)) {
    return { kind: 'unavailable', reason: 'Hermes read response could not be fitted to the context byte budget' };
  }
  return { kind: 'available', snapshot };
}

/**
 * Force a snapshot under its declared byte budget, in place.
 *
 * Trimming turns alone was not enough: the budget bounds the *serialized*
 * snapshot, and identity plus session metadata can already exceed it on their
 * own — 32 sessions of 32 tabs, or identity fields whose control characters
 * each cost six bytes once JSON-escaped. When that happened the reader still
 * reported `available` and handed back a snapshot several times the budget the
 * caller declared.
 *
 * Sessions are dropped from the end after the turns, because a shorter session
 * list is a truthful subset while a re-encoded conversation id would not be. If
 * even an empty snapshot does not fit, the honest answer is that context is
 * unavailable — never a snapshot that breaks the bound the caller asked for.
 */
function fitSnapshotToBytes(snapshot: HermesConversationSnapshot, maxBytes: number): boolean {
  const fits = (): boolean => Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= maxBytes;
  if (fits()) return true;

  snapshot.turns = trimTurnsToBytes(snapshot.turns, maxBytes, snapshot);
  if (fits()) return true;

  while (snapshot.sessions.length > 0) {
    snapshot.sessions.pop();
    if (fits()) return true;
  }
  return false;
}

/**
 * A turn budget is a count, so it has to survive being zero or hostile.
 *
 * `slice(-n)` reads a zero as "start at index 0" and a negative as "drop the
 * first n", so an unclamped budget *widened* the read instead of narrowing it:
 * the status tools ask for `maxTurns: 0` and were handed every turn the
 * endpoint offered. Anything that is not a usable count fails closed to zero
 * rather than to the whole transcript.
 */
function resolveTurnBudget(requested: number | undefined): number {
  if (requested === undefined) return VOICE_MAX_CONTEXT_TURNS;
  if (!Number.isFinite(requested)) return 0;
  return Math.max(0, Math.min(Math.floor(requested), VOICE_MAX_CONTEXT_TURNS));
}

function parseSession(value: unknown): SessionSummary | null {
  if (!isRecord(value)) return null;
  const id = boundedRequiredString(value.id, 256);
  const title = boundedRequiredString(value.title, 256);
  const status = boundedRequiredString(value.status, 128);
  if (!id || !title || !status || !Array.isArray(value.tabs)) return null;
  const tabs = value.tabs.slice(0, MAX_TABS_PER_SESSION).map((tab) => {
    if (!isRecord(tab) || typeof tab.title !== 'string' || typeof tab.isActive !== 'boolean' || typeof tab.status !== 'string') return null;
    return { title: truncateUtf8(tab.title, 256), isActive: tab.isActive, status: truncateUtf8(tab.status, 128) };
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

/**
 * The cap is measured in bytes, so the cut has to be made in bytes too.
 *
 * `value.slice(0, maxBytes)` measured the overflow correctly and then cut by
 * UTF-16 code units, which is not a fix at all: a 600-byte Japanese
 * conversation id is 200 code units, so a 256-byte cap let all 600 bytes
 * through untouched.
 */
function boundedRequiredString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return truncateUtf8(value, maxBytes);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
