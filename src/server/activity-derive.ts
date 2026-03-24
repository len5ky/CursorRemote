import type {
  ActivitySource,
  AgentStatus,
  ChatElement,
  CursorState,
  RawSignals,
} from './types.js';

/** Matches dom-extractor: header shows finished timing (for 2s or trailing 9s). */
export function collapsibleHeaderTextLooksComplete(ht: string): boolean {
  const t = ht.replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/\bfor\s+[\d.]+\s*s(ec(onds?)?)?\b/i.test(t)) return true;
  if (/\b[\d.]+\s*s(ec(onds?)?)?\s*$/i.test(t)) return true;
  return false;
}

const KNOWN_EXTS = /\.(ts|js|tsx|jsx|py|rs|go|md|json|css|html|vue|svelte|sh|txt|toml|yaml|yml)(?!\w)/;

export function sanitizeActivityLabel(text: string, fallback: string): string {
  let t = text.replace(/Loading$/, '').replace(/Waiting for output$/, '').trim();
  const looksLikeCode =
    /[{}();=]/.test(t) ||
    /\b(function|const|import|let|var|return|class)\s/.test(t) ||
    /\|\||&&|=>/.test(t) ||
    t.includes('\n') ||
    (/\s{2,}/.test(t) && t.length > 30);
  if (looksLikeCode) {
    const extMatch = t.match(KNOWN_EXTS);
    if (extMatch && extMatch.index !== undefined) {
      t = t.substring(0, extMatch.index + extMatch[0].length);
    } else {
      t = fallback;
    }
  }
  return t.substring(0, 64) || fallback;
}

export interface DerivedActivityState {
  status: AgentStatus;
  activityText: string | null;
  isLive: boolean;
  source: ActivitySource;
}

const FINISHED_ACTIVITY_RE =
  /\b(stopped|complete(?:d)?|done|finished|failed|cancelled|canceled|interrupted|terminated|success(?:ful|fully)?)\b/i;

function looksFinishedActivity(text: string): boolean {
  return FINISHED_ACTIVITY_RE.test(text);
}

function getLastLoadingTool(
  messages?: ChatElement[]
): Extract<ChatElement, { type: 'tool' }> | undefined {
  return messages
    ? [...messages].reverse().find(
        (m): m is Extract<ChatElement, { type: 'tool' }> =>
          m.type === 'tool' && m.status === 'loading'
      )
    : undefined;
}

function hasLiveLoadingIndicator(raw: RawSignals): boolean {
  return (
    raw.loadingIndicator ||
    (raw.orphanIndicators?.some((o) => o.cls.includes('loading-indicator')) ?? false) ||
    raw.elements.some((el) => el.parsedAs === 'skipped:loading' || el.indicators?.includes('loading-v3'))
  );
}

function activityFromThoughtTail(messages?: ChatElement[], raw?: RawSignals): DerivedActivityState | null {
  if (!messages || messages.length === 0 || !raw || raw.elements.length === 0) return null;
  const last = messages[messages.length - 1];
  const lastRaw = raw.elements[raw.elements.length - 1];
  if (last.type !== 'thought' || last.duration) return null;
  const umbrellaDone =
    last.thoughtKind === 'step_summary' && (last.detail || '').trim().length > 0;
  if (umbrellaDone) return null;
  if (lastRaw.parsedAs !== 'thought' || !lastRaw.indicators.includes('make-shine')) return null;
  return {
    status: 'thinking',
    activityText: sanitizeActivityLabel(last.action || 'Thinking', 'Thinking'),
    isLive: true,
    source: 'tail_thought',
  };
}

/**
 * Derive header activity from recorded raw signals + parsed messages (replay / tests).
 * Aligns with dom-extractor post-processing when full DOM is unavailable.
 */
export function deriveActivityFromSignals(
  raw: RawSignals,
  messages: ChatElement[] = [],
  baseStatus: AgentStatus = 'idle'
): DerivedActivityState {
  if (baseStatus === 'waiting_approval') {
    return { status: 'waiting_approval', activityText: null, isLive: false, source: 'none' };
  }
  if (baseStatus === 'error') {
    return { status: 'error', activityText: null, isLive: false, source: 'none' };
  }

  const activeShimmer = raw.shimmer.filter(
    (s) =>
      s.inHeader &&
      !collapsibleHeaderTextLooksComplete(s.text) &&
      !looksFinishedActivity(s.text)
  );
  const outside = activeShimmer.find((s) => !s.inToolCall);
  const inside = activeShimmer.find((s) => s.inToolCall);

  if (outside) {
    return {
      status: 'thinking',
      activityText: sanitizeActivityLabel(outside.text, 'Thinking'),
      isLive: true,
      source: 'shimmer',
    };
  }
  if (inside) {
    const label = sanitizeActivityLabel(inside.text, 'Running');
    if (label && !looksFinishedActivity(label)) {
      return {
        status: 'running_tool',
        activityText: label,
        isLive: true,
        source: 'shimmer',
      };
    }
    const lastTool = getLastLoadingTool(messages);
    const toolLabel = lastTool
      ? `Editing ${lastTool.filename || lastTool.details || lastTool.action}`
      : 'Running';
    return {
      status: 'running_tool',
      activityText: sanitizeActivityLabel(toolLabel, 'Running'),
      isLive: true,
      source: 'shimmer',
    };
  }

  const liveThought = activityFromThoughtTail(messages, raw);
  if (liveThought) return liveThought;

  const lt = getLastLoadingTool(messages);
  if (lt && messages[messages.length - 1]?.id === lt.id) {
    const label = (lt.action || lt.details || 'Running').trim();
    return {
      status: 'running_tool',
      activityText: sanitizeActivityLabel(label, 'Running'),
      isLive: true,
      source: 'loading_tool',
    };
  }

  if (hasLiveLoadingIndicator(raw)) {
    return {
      status: 'thinking',
      activityText: 'Thinking',
      isLive: true,
      source: 'loading_indicator',
    };
  }

  return {
    status: 'idle',
    activityText: null,
    isLive: false,
    source: 'none',
  };
}

export function applyDerivedActivityToState(state: CursorState): CursorState {
  if (!state._rawSignals) return state;
  const derived = deriveActivityFromSignals(state._rawSignals, state.messages, state.agentStatus);
  return {
    ...state,
    agentStatus: derived.status,
    agentActivityText: derived.activityText,
    agentActivityLive: derived.isLive,
    agentActivitySource: derived.source,
  };
}
