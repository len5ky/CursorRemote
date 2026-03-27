import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  formatElement,
  formatActivity,
  formatQuestionnaire,
  thoughtAppearsInProgress,
  activityRedundantWithInProgressStepSummary,
} from '../src/server/transports/telegram/formatter.js';
import type {
  ChatElement,
  ThoughtBlock,
  RunCommand,
  ToolCallElement,
  PlanBlock,
  AssistantMessage,
  HumanMessage,
  Questionnaire,
  CursorState,
} from '../src/server/types.js';

const dummyHash = (_sp: string) => '00000000';

function loadFixture(name: string): Array<{ ts: number; state: CursorState | null }> {
  const lines = readFileSync(resolve('fixtures/recordings', name), 'utf-8').trim().split('\n');
  return lines.map(l => JSON.parse(l));
}

// ─── formatActivity ───

describe('formatActivity', () => {
  it('wraps text in italic with shimmer spoiler', () => {
    const html = formatActivity('Planning next moves');
    assert.match(html, /●/);
    assert.match(html, /Planning next moves/);
    assert.match(html, /<tg-spoiler>/);
    assert.match(html, /<\/i>/);
  });

  it('escapes HTML entities', () => {
    const html = formatActivity('Reading <script>');
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});

// ─── thoughtAppearsInProgress ───

describe('thoughtAppearsInProgress', () => {
  it('returns true for active thought without duration', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: '',
      action: 'Planning', thoughtKind: 'step_summary',
    };
    assert.equal(thoughtAppearsInProgress(msg), true);
  });

  it('returns false when duration is set', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: 'for 2s',
      action: 'Planning', thoughtKind: 'step_summary',
    };
    assert.equal(thoughtAppearsInProgress(msg), false);
  });

  it('returns false for completed step_summary with detail', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: '',
      action: 'Explored', detail: 'Found 3 files', thoughtKind: 'step_summary',
    };
    assert.equal(thoughtAppearsInProgress(msg), false);
  });
});

// ─── formatElement for thoughts with spoiler shimmer ───

describe('formatElement thought shimmer', () => {
  it('adds spoiler to in-progress step_summary', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: '',
      action: 'Planning next moves', thoughtKind: 'step_summary',
    };
    const { html } = formatElement(msg, dummyHash);
    assert.match(html, /📎/);
    assert.match(html, /Planning next moves/);
    assert.match(html, /<tg-spoiler>/);
  });

  it('omits spoiler from completed thought', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: 'for 5s',
      action: 'Planning next moves', detail: 'for 5s', thoughtKind: 'step_summary',
    };
    const { html } = formatElement(msg, dummyHash);
    assert.ok(!html.includes('<tg-spoiler>'));
  });

  it('adds spoiler to in-progress thinking_step', () => {
    const msg: ThoughtBlock = {
      type: 'thought', id: 't1', flatIndex: 0, duration: '',
      action: 'Reading code', thoughtKind: 'thinking_step',
    };
    const { html } = formatElement(msg, dummyHash);
    assert.match(html, /◆/);
    assert.match(html, /<tg-spoiler>/);
  });
});

// ─── activityRedundantWithInProgressStepSummary ───

describe('activityRedundantWithInProgressStepSummary', () => {
  it('returns true when activity matches in-progress step', () => {
    const elements: ChatElement[] = [
      {
        type: 'thought', id: 't1', flatIndex: 0, duration: '',
        action: 'Planning next moves', thoughtKind: 'step_summary',
      },
    ];
    assert.equal(activityRedundantWithInProgressStepSummary('Planning next moves', elements), true);
  });

  it('returns false when no matching step', () => {
    const elements: ChatElement[] = [
      {
        type: 'thought', id: 't1', flatIndex: 0, duration: '',
        action: 'Reading files', thoughtKind: 'step_summary',
      },
    ];
    assert.equal(activityRedundantWithInProgressStepSummary('Planning next moves', elements), false);
  });

  it('returns false for empty activity', () => {
    assert.equal(activityRedundantWithInProgressStepSummary('', []), false);
  });

  it('returns false for completed step_summary', () => {
    const elements: ChatElement[] = [
      {
        type: 'thought', id: 't1', flatIndex: 0, duration: 'for 2s',
        action: 'Planning next moves', thoughtKind: 'step_summary',
      },
    ];
    assert.equal(activityRedundantWithInProgressStepSummary('Planning next moves', elements), false);
  });
});

// ─── formatElement for various types ───

describe('formatElement', () => {
  it('formats human message', () => {
    const msg: HumanMessage = {
      type: 'human', id: 'h1', flatIndex: 0, text: 'Hello world', mentions: [],
    };
    const { html } = formatElement(msg, dummyHash);
    assert.match(html, /You:/);
    assert.match(html, /Hello world/);
  });

  it('formats assistant message', () => {
    const msg: AssistantMessage = {
      type: 'assistant', id: 'a1', flatIndex: 0,
      text: 'Done!', html: 'Done!', codeBlocks: [],
    };
    const { html } = formatElement(msg, dummyHash);
    assert.match(html, /Done!/);
  });

  it('formats tool with filename and diff stats', () => {
    const msg: ToolCallElement = {
      type: 'tool', id: 'tool1', flatIndex: 0, toolCallId: 'tc1',
      status: 'completed', action: 'Edit', details: 'src/app.ts',
      filename: 'src/app.ts', additions: 5, deletions: 2,
    };
    const { html, keyboard } = formatElement(msg, dummyHash);
    assert.match(html, /src\/app\.ts/);
    assert.match(html, /\+5/);
    assert.match(html, /-2/);
    assert.ok(keyboard);
  });

  it('formats tool with actions (approval buttons)', () => {
    const msg: ToolCallElement = {
      type: 'tool', id: 'tool1234', flatIndex: 0, toolCallId: 'tc1',
      status: 'loading', action: 'Edit', details: 'src/app.ts',
      filename: 'src/app.ts',
      actions: [
        { label: 'Accept', type: 'run', selectorPath: 'sp-run' },
        { label: 'Skip', type: 'skip', selectorPath: 'sp-skip' },
      ],
    };
    const { keyboard } = formatElement(msg, dummyHash);
    assert.ok(keyboard);
  });

  it('formats run_command with command text and buttons', () => {
    const msg: RunCommand = {
      type: 'run_command', id: 'rc123456', flatIndex: 0, toolCallId: 'tc-run',
      description: 'Run outside sandbox', candidates: 'npm, test',
      command: 'npm test',
      actions: [
        { label: 'Skip', type: 'skip', selectorPath: 'sp-skip' },
        { label: 'Run', type: 'run', selectorPath: 'sp-run' },
      ],
    };
    const { html, keyboard } = formatElement(msg, dummyHash);
    assert.match(html, /Run outside sandbox/);
    assert.match(html, /npm test/);
    assert.ok(keyboard);
  });

  it('formats plan with todos and actions', () => {
    const msg: PlanBlock = {
      type: 'plan', id: 'plan1234', flatIndex: 0,
      label: 'Auth System', title: 'Auth System',
      todosCompleted: 1, todosTotal: 3,
      todos: [
        { text: 'Login endpoint', status: 'completed' },
        { text: 'Middleware', status: 'in_progress' },
        { text: 'User model', status: 'pending' },
      ],
      actions: [
        { label: 'View Plan', type: 'view_plan', selectorPath: 'sp-view' },
        { label: 'Build', type: 'build', selectorPath: 'sp-build' },
      ],
    };
    const { html, keyboard } = formatElement(msg, dummyHash);
    assert.match(html, /Auth System/);
    assert.match(html, /1\/3/);
    assert.match(html, /✅/);
    assert.match(html, /🔵/);
    assert.match(html, /⚪/);
    assert.ok(keyboard);
  });
});

// ─── Fixture-driven: approval lifecycle renders correctly ───

describe('approval fixture lifecycle', () => {
  const snapshots = loadFixture('approval-widget-lifecycle.jsonl');

  it('renders run_command with Skip/Run buttons', () => {
    const s = snapshots[1].state!;
    const rc = s.messages.find(m => m.type === 'run_command')!;
    const { html, keyboard } = formatElement(rc, dummyHash);
    assert.match(html, /npm test/);
    assert.match(html, /Run outside sandbox/);
    assert.ok(keyboard);
  });

  it('renders completed tool after approval', () => {
    const s = snapshots[3].state!;
    const tool = s.messages.find(m => m.type === 'tool')!;
    const { html } = formatElement(tool, dummyHash);
    assert.match(html, /Shell/);
  });
});

// ─── Fixture-driven: plan widget ───

describe('plan fixture rendering', () => {
  const snapshots = loadFixture('plan-widget.jsonl');

  it('renders plan block with todos', () => {
    const s = snapshots[1].state!;
    const plan = s.messages.find(m => m.type === 'plan')!;
    const { html, keyboard } = formatElement(plan, dummyHash);
    assert.match(html, /Auth System/);
    assert.match(html, /0\/3/);
    assert.match(html, /Add login endpoint/);
    assert.ok(keyboard);
  });
});

// --- Fixture-driven: fetch tool with actions ---

describe('fetch tool fixture rendering', () => {
  const snapshots = loadFixture('fetch-tool.jsonl');

  it('renders fetch tool with action and URL detail', () => {
    const s = snapshots[1].state!;
    const fetchTool = s.messages.find(m => m.type === 'tool')!;
    const { html } = formatElement(fetchTool, dummyHash);
    assert.match(html, /Fetch/);
    assert.match(html, /reddit\.com/);
  });

  it('renders fetch tool with approval buttons', () => {
    const s = snapshots[1].state!;
    const fetchTool = s.messages.find(m => m.type === 'tool')! as ToolCallElement;
    assert.ok(fetchTool.actions, 'Fetch tool should have actions');
    assert.ok(fetchTool.actions!.length >= 2, `Expected 2+ actions, got ${fetchTool.actions!.length}`);
    const types = fetchTool.actions!.map(a => a.type);
    assert.ok(types.includes('skip'), 'Should have skip action');
    assert.ok(types.includes('run') || types.includes('allow'), 'Should have run or allow action');
  });

  it('renders completed fetch tool without actions', () => {
    const s = snapshots[3].state!;
    const fetchTool = s.messages.find(m => m.type === 'tool')! as ToolCallElement;
    assert.equal(fetchTool.status, 'completed');
    assert.ok(!fetchTool.actions || fetchTool.actions.length === 0, 'Completed fetch should have no actions');
  });
});

// ─── formatAssistant: empty HTML fallback ───

describe('formatAssistant empty html', () => {
  it('returns empty html when msg.html is empty (no unformatted flash)', () => {
    const msg: AssistantMessage = {
      type: 'assistant', id: 'a1', flatIndex: 0,
      text: 'HelloWorld', html: '', codeBlocks: [],
    };
    const { html } = formatElement(msg, dummyHash);
    assert.equal(html, '', 'Should return empty html to skip message until HTML is available');
  });

  it('returns formatted html when msg.html is present', () => {
    const msg: AssistantMessage = {
      type: 'assistant', id: 'a1', flatIndex: 0,
      text: 'Hello World', html: '<p>Hello World</p>', codeBlocks: [],
    };
    const { html } = formatElement(msg, dummyHash);
    assert.ok(html.length > 0, 'Should return non-empty html');
    assert.match(html, /Hello World/);
  });
});

// ─── formatQuestionnaire ───

describe('formatQuestionnaire', () => {
  const sampleQuestionnaire: Questionnaire = {
    questions: [
      {
        number: '1.',
        text: 'What is your favorite season?',
        isActive: true,
        options: [
          { letter: 'A', label: 'Spring', isFreeform: false, selectorPath: 'sp-a' },
          { letter: 'B', label: 'Summer', isFreeform: false, selectorPath: 'sp-b' },
          { letter: 'C', label: 'Autumn', isFreeform: false, selectorPath: 'sp-c' },
          { letter: 'D', label: 'Other', isFreeform: true, selectorPath: 'sp-d' },
        ],
      },
      {
        number: '2.',
        text: 'What is your go-to drink?',
        isActive: false,
        options: [
          { letter: 'A', label: 'Coffee', isFreeform: false, selectorPath: 'sp-coffee' },
          { letter: 'B', label: 'Tea', isFreeform: false, selectorPath: 'sp-tea' },
        ],
      },
    ],
    activeIndex: 0,
    totalLabel: '1 of 2',
    skipSelectorPath: 'sp-skip',
    continueSelectorPath: 'sp-continue',
    continueDisabled: false,
  };

  it('formats questionnaire with question text', () => {
    const { html } = formatQuestionnaire(sampleQuestionnaire, dummyHash);
    assert.match(html, /Questions/);
    assert.match(html, /1 of 2/);
    assert.match(html, /favorite season/);
  });

  it('produces inline keyboard with option buttons', () => {
    const { keyboard } = formatQuestionnaire(sampleQuestionnaire, dummyHash);
    assert.ok(keyboard, 'Should have inline keyboard');
  });

  it('includes Skip and Continue buttons when not disabled', () => {
    const { keyboard } = formatQuestionnaire(sampleQuestionnaire, dummyHash);
    assert.ok(keyboard, 'Should have keyboard');
    // Keyboard is an InlineKeyboard instance — verify it serialized
    const json = JSON.stringify(keyboard);
    assert.match(json, /Skip/);
    assert.match(json, /Continue/);
  });

  it('omits Continue button when disabled', () => {
    const disabled = { ...sampleQuestionnaire, continueDisabled: true };
    const { keyboard } = formatQuestionnaire(disabled, dummyHash);
    const json = JSON.stringify(keyboard);
    assert.ok(!json.includes('Continue'), 'Should not have Continue when disabled');
  });

  it('returns empty html for empty questions', () => {
    const empty: Questionnaire = {
      ...sampleQuestionnaire, questions: [],
    };
    const { html } = formatQuestionnaire(empty, dummyHash);
    assert.equal(html, '');
  });
});
