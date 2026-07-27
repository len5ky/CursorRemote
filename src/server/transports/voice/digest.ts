import type { CursorState, ChatElement } from '../../types.js';

/**
 * DICKTATOR digest layer.
 * Converts ChatElement state / transcript tails into short spoken-form
 * summaries via a cheap OpenRouter model. Strips file paths, hashes, and code
 * identifiers so nothing awkward is read aloud.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const DIGEST_SYSTEM_PROMPT =
  'You summarize a coding agent\'s activity for a driver using voice only. ' +
  'Respond with 2-3 short spoken sentences. Never read file paths, commit hashes, ' +
  'code identifiers, URLs, or shell commands aloud — describe them in plain words instead ' +
  '(e.g. "edited the server config file", "ran the test suite"). ' +
  'Lead with what matters: is the agent working, blocked, waiting for approval, or done.';

/** Flatten transcript elements into compact plain-text lines for the digest LLM. */
export function elementsToDigestLines(messages: ChatElement[]): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    switch (m.type) {
      case 'human':
        lines.push(`User asked: ${m.text.substring(0, 300)}`);
        break;
      case 'assistant':
        if (m.text.trim()) lines.push(`Agent said: ${m.text.substring(0, 400)}`);
        break;
      case 'tool':
        lines.push(`Tool ${m.status === 'loading' ? 'running' : 'done'}: ${m.action} ${m.details}`.substring(0, 200));
        break;
      case 'thought':
        if (m.action) lines.push(`Agent step: ${m.action}${m.detail ? ` — ${m.detail}` : ''}`.substring(0, 200));
        break;
      case 'plan':
        lines.push(`Plan "${m.title}": ${m.todosCompleted} of ${m.todosTotal} items done`);
        break;
      case 'todo_list':
        lines.push(`Todo list "${m.title}": ${m.todosCompleted} of ${m.todosTotal} done`);
        break;
      case 'run_command':
        lines.push(`Pending command awaiting decision: ${m.description || m.command}`.substring(0, 200));
        break;
      case 'loading':
        break;
      default: {
        const _exhaustive: never = m;
        void _exhaustive;
      }
    }
  }
  return lines;
}

/** Build the user prompt for the digest model from state + optional transcript tail. */
export function buildDigestPrompt(messages: ChatElement[], state: CursorState): string {
  const parts: string[] = [];
  parts.push(`Agent status: ${state.agentStatus}${state.agentActivityText ? ` (${state.agentActivityText})` : ''}.`);
  if (state.pendingApprovals.length > 0) {
    parts.push(`Pending approvals: ${state.pendingApprovals.map(a => a.description.substring(0, 150)).join(' | ')}`);
  }
  const lines = elementsToDigestLines(messages);
  if (lines.length > 0) {
    parts.push('Recent transcript:');
    parts.push(...lines.slice(-15));
  }
  return parts.join('\n');
}

/** Deterministic fallback used when no OpenRouter key or the call fails. */
export function fallbackDigest(messages: ChatElement[], state: CursorState): string {
  const bits: string[] = [];
  const statusMap: Record<string, string> = {
    idle: 'The agent is idle.',
    thinking: 'The agent is thinking.',
    generating: 'The agent is writing a response.',
    running_tool: 'The agent is running a tool.',
    waiting_approval: 'The agent is waiting for your approval.',
    error: 'The agent hit an error.',
  };
  bits.push(statusMap[state.agentStatus] ?? `Agent status is ${state.agentStatus}.`);
  if (state.pendingApprovals.length > 0) {
    bits.push(`There ${state.pendingApprovals.length === 1 ? 'is one pending approval' : `are ${state.pendingApprovals.length} pending approvals`}.`);
  }
  const lastAssistant = [...messages].reverse().find(m => m.type === 'assistant' && m.text.trim());
  if (lastAssistant && lastAssistant.type === 'assistant') {
    bits.push(`Last update: ${sanitizeForSpeech(lastAssistant.text).substring(0, 200)}`);
  }
  return bits.join(' ');
}

/** Best-effort removal of paths/hashes/identifiers for spoken output. */
export function sanitizeForSpeech(text: string): string {
  return text
    // code fences and inline code
    .replace(/```[\s\S]*?```/g, ' a code block ')
    .replace(/`[^`]+`/g, ' code ')
    // file paths (unix + windows)
    .replace(/(?:[A-Za-z]:)?(?:\/|\\)[\w.\-\\/]+/g, ' a file path ')
    .replace(/\b[\w-]+\/[\w./-]+\.(?:ts|js|tsx|jsx|py|md|json|css|html|rs|go)\b/g, ' a file ')
    // long hex hashes
    .replace(/\b[0-9a-f]{7,40}\b/gi, ' a hash ')
    // URLs
    .replace(/https?:\/\/\S+/g, ' a link ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DigestClientOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export class DigestClient {
  private apiKey: string;
  private model: string;
  private fetchImpl: typeof fetch;

  constructor(opts: DigestClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async digest(messages: ChatElement[], state: CursorState): Promise<string> {
    if (!this.apiKey) return fallbackDigest(messages, state);
    try {
      const resp = await this.fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 200,
          messages: [
            { role: 'system', content: DIGEST_SYSTEM_PROMPT },
            { role: 'user', content: buildDigestPrompt(messages, state) },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
      const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error('Empty digest response');
      return sanitizeForSpeech(content);
    } catch (err) {
      console.warn(`[dicktator] Digest failed, using fallback: ${err instanceof Error ? err.message : err}`);
      return fallbackDigest(messages, state);
    }
  }
}
