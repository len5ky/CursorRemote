import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  VoiceToolRouter,
  isMutatingTool,
  VOICE_TOOL_SCHEMAS,
  type VoiceToolDeps,
  type SessionSummary,
  type VoiceToolAuthority,
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
  const target: { windowId: string; composerId: string; revision: string; ageMs: number } = {
    windowId: 'w1', composerId: 'composer-1', revision: 'rev-1', ageMs: 10
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
    getPinnedTarget: () => target,
    revalidateTarget: (expected) => {
      return expected.windowId === target.windowId
        && expected.composerId === target.composerId
        && expected.revision === target.revision;
    },
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

  it('disconnect_voice invokes only the dedicated termination control', async () => {
    const { deps, calls } = makeDeps(baseState());
    const router = new VoiceToolRouter({
      ...deps,
      terminateVoice: async () => {
        calls.push({ name: 'terminateVoice', args: [] });
        return { state: 'terminated' };
      },
    });
    const result = await router.call('disconnect_voice', {});
    assert.equal(result.ok, true);
    assert.equal(calls.filter(c => c.name === 'terminateVoice').length, 1);
    assert.equal(calls.filter(c => c.name === 'clickApproval' || c.name === 'clickAction').length, 0);
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

  it('consumes the token when the mutation succeeds but post-mutation validation fails', async () => {
    const made = makeDeps(state);
    let validations = 0;
    const router = new VoiceToolRouter({
      ...made.deps,
      // Pre-mutation revalidate passes once; post-mutation revalidate fails.
      revalidateTarget: () => ++validations < 2,
    });
    await router.call('set_target', { window: 'my-project' });
    const token = extractToken((await router.call('approve', {})).output);
    assert.ok(router.getPending(token)?.target, 'pending must pin a target for post-check to run');
    const failed = await router.call('confirm_pending', { token });
    assert.equal(failed.ok, false);
    assert.match(failed.output, /during mutation execution/i);
    assert.equal(made.calls.filter(c => c.name === 'clickApproval').length, 1);
    assert.equal(router.getPending(token), undefined);
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
    assert.equal(clickCall!.args[1], 'Run');
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

  it('survives a stale authority rejection and can retry', async () => {
    const context = { sessionId: 'voice-1', epoch: 7, leaseId: 'lease-1' };
    const target = { windowId: 'w1', composerId: 'composer-1', revision: 'rev-1', ageMs: 10 };
    let targetHealthy = true;
    const authority: VoiceToolAuthority = {
      accepts: (candidate) => candidate.sessionId === context.sessionId && candidate.epoch === context.epoch && candidate.leaseId === context.leaseId,
      live: () => true,
      mutationHealth: () => targetHealthy ? { ok: true } : { ok: false, reason: 'Pinned Cursor target changed.' },
      committed: () => {},
    };
    const made = makeDeps(state);
    const router = new VoiceToolRouter({ ...made.deps, getPinnedTarget: () => target }, authority);
    await router.call('set_target', { window: 'my-project' }, context);
    const staged = await router.call('approve', {}, context);
    const token = extractToken(staged.output);
    const pending = router.getPending(token);
    assert.equal(pending?.sessionId, context.sessionId);
    assert.equal(pending?.target?.revision, 'rev-1');
    assert.match(pending?.argsDigest ?? '', /^[a-f0-9]{64}$/);

    targetHealthy = false;
    const confirmed = await router.call('confirm_pending', { token }, context);
    assert.equal(confirmed.ok, false);
    assert.equal(made.calls.filter(c => c.name === 'clickApproval').length, 0);
    // Token survives a stale-authority rejection (TOCTOU fix)
    assert.notEqual(router.getPending(token), undefined);

    targetHealthy = true;
    const retry = await router.call('confirm_pending', { token }, context);
    assert.equal(retry.ok, true);
    assert.equal(made.calls.filter(c => c.name === 'clickApproval').length, 1);
  });

  it('keeps the token and does not mutate when health turns stale during activation', async () => {
    const context = { sessionId: 'voice-1', epoch: 7, leaseId: 'lease-1' };
    const target = { windowId: 'w1', composerId: 'composer-1', revision: 'rev-1', ageMs: 10 };
    let targetHealthy = true;
    const authority: VoiceToolAuthority = {
      accepts: () => true,
      live: () => true,
      mutationHealth: () => targetHealthy ? { ok: true } : { ok: false, reason: 'Pinned Cursor target changed.' },
      committed: () => {},
    };
    const made = makeDeps(state);
    let activations = 0;
    const router = new VoiceToolRouter({
      ...made.deps,
      getPinnedTarget: () => target,
      activateTarget: async () => { if (++activations > 1) targetHealthy = false; },
    }, authority);
    await router.call('set_target', { window: 'my-project' }, context);
    const token = extractToken((await router.call('approve', {}, context)).output);

    const confirmed = await router.call('confirm_pending', { token }, context);

    assert.equal(confirmed.ok, false);
    assert.equal(made.calls.filter(c => c.name === 'clickApproval').length, 0);
    assert.notEqual(router.getPending(token), undefined);
  });

  it('keeps the token and does not mutate when identity changes during activation', async () => {
    const context = { sessionId: 'voice-1', epoch: 7, leaseId: 'lease-1' };
    const target = { windowId: 'w1', composerId: 'composer-1', revision: 'rev-1', ageMs: 10 };
    let accepted = true;
    const authority: VoiceToolAuthority = {
      accepts: () => accepted,
      live: () => true,
      mutationHealth: () => ({ ok: true }),
      committed: () => {},
    };
    const made = makeDeps(state);
    let activations = 0;
    const router = new VoiceToolRouter({
      ...made.deps,
      getPinnedTarget: () => target,
      activateTarget: async () => { if (++activations > 1) accepted = false; },
    }, authority);
    await router.call('set_target', { window: 'my-project' }, context);
    const token = extractToken((await router.call('approve', {}, context)).output);

    const confirmed = await router.call('confirm_pending', { token }, context);

    assert.equal(confirmed.ok, false);
    assert.equal(made.calls.filter(c => c.name === 'clickApproval').length, 0);
    assert.notEqual(router.getPending(token), undefined);
  });
});
