import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  deriveActivityFromSignals,
  applyDerivedActivityToState,
  collapsibleHeaderTextLooksComplete,
  sanitizeActivityLabel,
} from '../src/server/activity-derive.js';
import type { CursorState, RawSignals, ChatElement } from '../src/server/types.js';

function loadFixture(name: string): Array<{ ts: number; state: CursorState | null }> {
  const lines = readFileSync(resolve('fixtures/recordings', name), 'utf-8').trim().split('\n');
  return lines.map(l => JSON.parse(l));
}

// ─── collapsibleHeaderTextLooksComplete ───

describe('collapsibleHeaderTextLooksComplete', () => {
  it('returns true for "for 2s"', () => {
    assert.equal(collapsibleHeaderTextLooksComplete('Reading file for 2s'), true);
  });
  it('returns true for trailing seconds', () => {
    assert.equal(collapsibleHeaderTextLooksComplete('Editing 3.5s'), true);
  });
  it('returns false for active shimmer text', () => {
    assert.equal(collapsibleHeaderTextLooksComplete('Planning next moves'), false);
  });
  it('returns false for empty string', () => {
    assert.equal(collapsibleHeaderTextLooksComplete(''), false);
  });
});

// ─── sanitizeActivityLabel ───

describe('sanitizeActivityLabel', () => {
  it('strips trailing "Loading"', () => {
    assert.equal(sanitizeActivityLabel('Checking filesLoading', 'fallback'), 'Checking files');
  });
  it('truncates at 64 chars', () => {
    const long = 'A'.repeat(100);
    assert.equal(sanitizeActivityLabel(long, 'fb').length, 64);
  });
  it('detects code-like text and returns fallback', () => {
    assert.equal(sanitizeActivityLabel('const x = { foo: () => bar }', 'Running'), 'Running');
  });
  it('extracts filename from code-like text', () => {
    const label = sanitizeActivityLabel('import foo from app.ts stuff', 'Running');
    assert.equal(label, 'import foo from app.ts');
  });
  it('returns fallback for empty input', () => {
    assert.equal(sanitizeActivityLabel('', 'Thinking'), 'Thinking');
  });
});

// ─── deriveActivityFromSignals ───

describe('deriveActivityFromSignals', () => {
  it('returns idle when no signals', () => {
    const raw: RawSignals = { shimmer: [], loadingIndicator: false, elements: [], orphanIndicators: [] };
    const result = deriveActivityFromSignals(raw, [], 'idle');
    assert.equal(result.status, 'idle');
    assert.equal(result.activityText, null);
    assert.equal(result.isLive, false);
    assert.equal(result.source, 'none');
  });

  it('returns waiting_approval passthrough', () => {
    const raw: RawSignals = { shimmer: [], loadingIndicator: false, elements: [], orphanIndicators: [] };
    const result = deriveActivityFromSignals(raw, [], 'waiting_approval');
    assert.equal(result.status, 'waiting_approval');
    assert.equal(result.isLive, false);
  });

  it('returns error passthrough', () => {
    const raw: RawSignals = { shimmer: [], loadingIndicator: false, elements: [], orphanIndicators: [] };
    const result = deriveActivityFromSignals(raw, [], 'error');
    assert.equal(result.status, 'error');
  });

  it('derives shimmer outside tool call as thinking', () => {
    const raw: RawSignals = {
      shimmer: [{ text: 'Planning next moves', inToolCall: false, inHeader: true }],
      loadingIndicator: false,
      elements: [],
      orphanIndicators: [],
    };
    const result = deriveActivityFromSignals(raw);
    assert.equal(result.status, 'thinking');
    assert.equal(result.activityText, 'Planning next moves');
    assert.equal(result.isLive, true);
    assert.equal(result.source, 'shimmer');
  });

  it('derives shimmer inside tool call as running_tool', () => {
    const raw: RawSignals = {
      shimmer: [{ text: 'Editing app.ts', inToolCall: true, inHeader: true }],
      loadingIndicator: false,
      elements: [],
      orphanIndicators: [],
    };
    const result = deriveActivityFromSignals(raw);
    assert.equal(result.status, 'running_tool');
    assert.equal(result.activityText, 'Editing app.ts');
    assert.equal(result.isLive, true);
  });

  it('ignores completed shimmer text', () => {
    const raw: RawSignals = {
      shimmer: [{ text: 'Reading file for 2s', inToolCall: false, inHeader: true }],
      loadingIndicator: false,
      elements: [],
      orphanIndicators: [],
    };
    const result = deriveActivityFromSignals(raw);
    assert.equal(result.status, 'idle');
    assert.equal(result.activityText, null);
  });

  it('detects loading indicator as thinking', () => {
    const raw: RawSignals = {
      shimmer: [],
      loadingIndicator: true,
      elements: [],
      orphanIndicators: [],
    };
    const result = deriveActivityFromSignals(raw);
    assert.equal(result.status, 'thinking');
    assert.equal(result.activityText, 'Thinking');
    assert.equal(result.isLive, true);
    assert.equal(result.source, 'loading_indicator');
  });

  it('derives tail thought activity', () => {
    const messages: ChatElement[] = [
      {
        type: 'thought', id: 't1', flatIndex: 0, duration: '',
        action: 'Planning next moves', thoughtKind: 'step_summary',
      },
    ];
    const raw: RawSignals = {
      shimmer: [],
      loadingIndicator: false,
      elements: [{ flatIndex: 0, indicators: ['make-shine'], textPreview: 'Planning next moves', parsedAs: 'thought' }],
      orphanIndicators: [],
    };
    const result = deriveActivityFromSignals(raw, messages);
    assert.equal(result.status, 'thinking');
    assert.equal(result.activityText, 'Planning next moves');
    assert.equal(result.source, 'tail_thought');
  });

  it('does not derive tail thought when step_summary has detail', () => {
    const messages: ChatElement[] = [
      {
        type: 'thought', id: 't1', flatIndex: 0, duration: '',
        action: 'Explored', detail: 'Found 3 files', thoughtKind: 'step_summary',
      },
    ];
    const raw: RawSignals = {
      shimmer: [],
      loadingIndicator: false,
      elements: [{ flatIndex: 0, indicators: ['make-shine'], textPreview: 'Explored', parsedAs: 'thought' }],
      orphanIndicators: [],
    };
    const result = deriveActivityFromSignals(raw, messages);
    assert.equal(result.status, 'idle');
  });

  it('detects loading tool as last message', () => {
    const messages: ChatElement[] = [
      {
        type: 'tool', id: 'tool1', flatIndex: 0, toolCallId: 'tc1',
        status: 'loading', action: 'Edit', details: 'src/app.ts',
        filename: 'src/app.ts',
      },
    ];
    const raw: RawSignals = {
      shimmer: [],
      loadingIndicator: false,
      elements: [{ flatIndex: 0, toolStatus: 'loading', indicators: [], textPreview: 'Edit src/app.ts', parsedAs: 'tool' }],
      orphanIndicators: [],
    };
    const result = deriveActivityFromSignals(raw, messages);
    assert.equal(result.status, 'running_tool');
    assert.equal(result.isLive, true);
    assert.equal(result.source, 'loading_tool');
  });
});

// ─── applyDerivedActivityToState ───

describe('applyDerivedActivityToState', () => {
  it('applies derived activity to state from raw signals', () => {
    const snapshots = loadFixture('activity-shimmer-lifecycle.jsonl');
    const thinkingSnapshot = snapshots[1].state!;
    const result = applyDerivedActivityToState(thinkingSnapshot);
    assert.equal(result.agentStatus, 'thinking');
    assert.equal(result.agentActivityText, 'Planning next moves');
    assert.equal(result.agentActivityLive, true);
    assert.equal(result.agentActivitySource, 'shimmer');
  });

  it('returns idle when shimmer stops', () => {
    const snapshots = loadFixture('activity-shimmer-lifecycle.jsonl');
    const idleSnapshot = snapshots[4].state!;
    const result = applyDerivedActivityToState(idleSnapshot);
    assert.equal(result.agentStatus, 'idle');
    assert.equal(result.agentActivityText, null);
    assert.equal(result.agentActivityLive, false);
  });

  it('passes through state without _rawSignals unchanged', () => {
    const state: CursorState = {
      connected: true,
      extractorStatus: 'ok',
      lastExtractionAt: null,
      consecutiveExtractionFailures: 0,
      lastExtractionError: null,
      agentStatus: 'idle',
      agentActivityText: null,
      agentActivityLive: false,
      agentActivitySource: 'none',
      messages: [],
      pendingApprovals: [],
      inputAvailable: true,
      chatTabs: [],
      mode: { current: 'agent', available: [] },
      model: { current: 'test', currentId: 'test' },
      windows: [],
      activeWindowId: 'w0',
      composerQueue: { items: [] },
    };
    const result = applyDerivedActivityToState(state);
    assert.deepEqual(result, state);
  });
});

// ─── Fixture-driven lifecycle ───

describe('activity shimmer lifecycle (fixture)', () => {
  const snapshots = loadFixture('activity-shimmer-lifecycle.jsonl');

  it('starts idle', () => {
    const s = snapshots[0].state!;
    const d = deriveActivityFromSignals(s._rawSignals!, s.messages, s.agentStatus);
    assert.equal(d.status, 'idle');
    assert.equal(d.isLive, false);
  });

  it('transitions to thinking with shimmer', () => {
    const s = snapshots[1].state!;
    const d = deriveActivityFromSignals(s._rawSignals!, s.messages, s.agentStatus);
    assert.equal(d.status, 'thinking');
    assert.equal(d.isLive, true);
    assert.equal(d.activityText, 'Planning next moves');
  });

  it('transitions to running_tool with tool shimmer', () => {
    const s = snapshots[3].state!;
    const d = deriveActivityFromSignals(s._rawSignals!, s.messages, s.agentStatus);
    assert.equal(d.status, 'running_tool');
    assert.equal(d.isLive, true);
    assert.match(d.activityText!, /Editing/);
  });

  it('returns to idle at end', () => {
    const s = snapshots[4].state!;
    const d = deriveActivityFromSignals(s._rawSignals!, s.messages, s.agentStatus);
    assert.equal(d.status, 'idle');
    assert.equal(d.isLive, false);
    assert.equal(d.activityText, null);
  });
});
