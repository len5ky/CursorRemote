import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  VoiceToolRouter,
  isMutatingTool,
  VOICE_TOOL_SCHEMAS,
  type VoiceToolDeps,
  type SessionSummary,
} from '../src/server/transports/voice/tools.js';
import type { CursorState, ChatElement } from '../src/server/types.js';

function baseState(overrides: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
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
    activeComposerId: '',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: 'auto' },
    windows: [{ id: 'w1', title: 'my-project', url: '' }],
    activeWindowId: 'w1',
    composerQueue: { items: [] },
    questionnaire: null,
    ...overrides,
  };
}

interface CallLog {
  name: string;
  args: unknown[];
}

function makeDeps(state: CursorState, sessions?: SessionSummary[]): { deps: VoiceToolDeps; calls: CallLog[] } {
  const calls: CallLog[] = [];
  const log = (name: string) => (...args: unknown[]) => {
    calls.push({ name, args });
    return Promise.resolve();
  };
  const deps: VoiceToolDeps = {
    getState: () => state,
    listSessions: () => sessions ?? [
      { windowId: 'w1', windowTitle: 'my-project', tabs: [{ title: 'Build feature', isActive: true, status: 'idle' }] },
    ],
    activateTarget: log('activateTarget'),
    sendMessage: log('sendMessage'),
    clickApproval: log('clickApproval'),
    clickAction: log('clickAction'),
    setMode: log('setMode'),
    setModel: log('setModel'),
    digest: async () => 'digest text',
  };
  return { deps, calls };
}

function extractToken(output: string): string {
  const m = output.match(/token "([0-9a-f]+)"/);
  assert.ok(m, `expected token in output: ${output}`);
  return m![1];
}

describe('voice tool schemas', () => {
  it('every mutating tool has a schema, and confirm_pending exists', () => {
    const names = new Set(VOICE_TOOL_SCHEMAS.map(t => t.name));
    for (const t of ['send_to_session', 'approve', 'reject', 'run_action', 'skip_action', 'set_mode', 'set_model', 'cancel']) {
      assert.ok(isMutatingTool(t), `${t} should be mutating`);
      assert.ok(names.has(t), `${t} should have a schema`);
    }
    assert.ok(names.has('confirm_pending'));
    assert.ok(!isMutatingTool('list_sessions'));
    assert.ok(!isMutatingTool('get_status'));
    assert.ok(!isMutatingTool('read_recent'));
  });
});

describe('informational tools', () => {
  it('list_sessions returns window/tab names', async () => {
    const { deps } = makeDeps(baseState());
    const router = new VoiceToolRouter(deps);
    const r = await router.call('list_sessions', {});
    assert.equal(r.ok, true);
    assert.match(r.output, /my-project/);
    assert.match(r.output, /Build feature/);
  });

  it('read_recent uses digest', async () => {
    const state = baseState({
      messages: [{ type: 'assistant', id: 'a1', flatIndex: 0, text: 'hello', html: '', codeBlocks: [] }],
    });
    const { deps } = makeDeps(state);
    const router = new VoiceToolRouter(deps);
    const r = await router.call('read_recent', {});
    assert.equal(r.ok, true);
    assert.equal(r.output, 'digest text');
  });

  it('informational tools execute without confirmation', async () => {
    const { deps, calls } = makeDeps(baseState());
    const router = new VoiceToolRouter(deps);
    await router.call('get_all_status', {});
    // no mutating deps invoked
    assert.equal(calls.length, 0);
  });
});

describe('set_target', () => {
  it('fuzzy-matches window and sets sticky target', async () => {
    const { deps } = makeDeps(baseState());
    const router = new VoiceToolRouter(deps);
    const r = await router.call('set_target', { window: 'proj' });
    assert.equal(r.ok, true);
    assert.equal(router.currentTarget.windowId, 'w1');
  });

  it('rejects ambiguous window match', async () => {
    const sessions: SessionSummary[] = [
      { windowId: 'w1', windowTitle: 'proj-a', tabs: [] },
      { windowId: 'w2', windowTitle: 'proj-b', tabs: [] },
    ];
    const { deps } = makeDeps(baseState(), sessions);
    const router = new VoiceToolRouter(deps);
    const r = await router.call('set_target', { window: 'proj' });
    assert.equal(r.ok, false);
    assert.match(r.output, /Ambiguous/);
  });

  it('rejects unknown window', async () => {
    const { deps } = makeDeps(baseState());
    const router = new VoiceToolRouter(deps);
    const r = await router.call('set_target', { window: 'nope' });
    assert.equal(r.ok, false);
  });
});

describe('confirmation flow', () => {
  let state: CursorState;
  let deps: VoiceToolDeps;
  let calls: CallLog[];
  let router: VoiceToolRouter;

  beforeEach(() => {
    state = baseState({
      pendingApprovals: [{
        id: 'ap1',
        description: 'Run npm install',
        actions: [
          { label: 'Accept', type: 'approve', selectorPath: '.accept-btn' },
          { label: 'Reject', type: 'reject', selectorPath: '.reject-btn' },
        ],
      }],
    });
    const made = makeDeps(state);
    deps = made.deps;
    calls = made.calls;
    router = new VoiceToolRouter(deps);
  });

  it('mutating tool does NOT execute immediately — returns pending token', async () => {
    const r = await router.call('approve', {});
    assert.equal(r.ok, true);
    assert.equal(r.pending, true);
    assert.match(r.output, /PENDING CONFIRMATION/);
    assert.equal(calls.length, 0, 'no executor calls before confirmation');
  });

  it('confirm_pending with valid token executes the staged action', async () => {
    const staged = await router.call('approve', {});
    const token = extractToken(staged.output);
    const r = await router.call('confirm_pending', { token });
    assert.equal(r.ok, true);
    const clickCall = calls.find(c => c.name === 'clickApproval');
    assert.ok(clickCall);
    assert.equal(clickCall!.args[0], '.accept-btn');
  });

  it('confirm_pending with wrong token fails and executes nothing', async () => {
    await router.call('approve', {});
    const r = await router.call('confirm_pending', { token: 'deadbeef0000' });
    assert.equal(r.ok, false);
    assert.equal(calls.filter(c => c.name === 'clickApproval').length, 0);
  });

  it('tokens are single-use', async () => {
    const staged = await router.call('send_to_session', { text: 'hi there' });
    const token = extractToken(staged.output);
    const first = await router.call('confirm_pending', { token });
    assert.equal(first.ok, true);
    const second = await router.call('confirm_pending', { token });
    assert.equal(second.ok, false);
    assert.equal(calls.filter(c => c.name === 'sendMessage').length, 1);
  });

  it('reject stages the reject selector', async () => {
    const staged = await router.call('reject', {});
    const token = extractToken(staged.output);
    await router.call('confirm_pending', { token });
    const clickCall = calls.find(c => c.name === 'clickApproval');
    assert.equal(clickCall!.args[0], '.reject-btn');
  });

  it('approve fails cleanly when there is no pending approval', async () => {
    state.pendingApprovals = [];
    const r = await router.call('approve', {});
    assert.equal(r.ok, false);
    assert.match(r.output, /no pending approval/i);
  });

  it('run_action stages the run button from the latest run_command', async () => {
    const runCmd: ChatElement = {
      type: 'run_command', id: 'rc1', flatIndex: 3, toolCallId: 'tc1',
      description: 'Install deps', candidates: '', command: 'npm ci',
      actions: [
        { label: 'Run', type: 'run', selectorPath: '.run-btn' },
        { label: 'Skip', type: 'skip', selectorPath: '.skip-btn' },
      ],
    };
    state.messages = [runCmd];
    const staged = await router.call('run_action', {});
    assert.equal(staged.pending, true);
    const token = extractToken(staged.output);
    await router.call('confirm_pending', { token });
    const clickCall = calls.find(c => c.name === 'clickAction');
    assert.equal(clickCall!.args[0], '.run-btn');
  });

  it('set_mode + confirm routes to setMode with target activation', async () => {
    await router.call('set_target', { window: 'my-project' });
    const staged = await router.call('set_mode', { mode: 'plan' });
    const token = extractToken(staged.output);
    await router.call('confirm_pending', { token });
    assert.ok(calls.find(c => c.name === 'activateTarget'));
    const modeCall = calls.find(c => c.name === 'setMode');
    assert.equal(modeCall!.args[0], 'plan');
  });

  it('send_to_session requires non-empty text', async () => {
    const r = await router.call('send_to_session', { text: '   ' });
    assert.equal(r.ok, false);
  });
});
