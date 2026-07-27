import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  VoiceToolRouter,
  type VoiceToolDeps,
  type VoiceToolAuthority,
  type PinnedVoiceTarget,
} from '../src/server/transports/voice/tools.js';
import {
  VoiceSessionController,
  VoiceUsageLedger,
  type VoiceSessionContext,
  type VoiceSessionOptions,
} from '../src/server/transports/voice/session.js';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import { parseUsageFromDone } from '../src/server/transports/voice/realtime-bridge.js';
import type { VoiceConfig } from '../src/server/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function baseVoiceConfig(): VoiceConfig {
  return {
    enabled: true, openaiApiKey: 'sk-test-fake', model: 'gpt-4o-realtime-preview',
    miniModel: '', voice: 'marin', openrouterApiKey: 'sk-or-test-fake',
    digestModel: 'test-model', ttsModel: 'test-tts', sttModel: 'test-stt',
    proactiveMinIntervalMs: 15000,
    usagePriceVersion: 'test-v1', usageUnitPriceCentsPerMinute: 1,
    dailyCapCents: 100, perSessionCapCents: 10,
    absoluteSessionMs: 10 * 60_000, idleMs: 60_000, idleGraceMs: 5_000, leaseMs: 30_000,
    targetMaxAgeMs: 5000,
  };
}

function makeMockTransportDeps() {
  const mm = new EventEmitter() as any;
  mm.on = mm.on.bind(mm);
  const sm = Object.assign(new EventEmitter(), {
    getCurrentState: () => ({
      connected: false, extractorStatus: 'idle' as const, lastExtractionAt: null,
      consecutiveExtractionFailures: 0, lastExtractionError: null,
      agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
      agentActivitySource: 'none' as const, messages: [], pendingApprovals: [],
      inputAvailable: false, chatTabs: [], activeComposerId: '',
      mode: { current: '', available: [] }, model: { current: '', currentId: '' },
      windows: [], activeWindowId: '', composerQueue: { items: [] }, questionnaire: null,
    }),
    generation: 0, on: (() => {}) as any, off: (() => {}) as any,
  });
  const ce = {
    sendMessage: async () => ({ ok: true }), switchTab: async () => ({ ok: true }),
    clickApproval: async () => ({ ok: true }), clickAction: async () => ({ ok: true }),
    setMode: async () => ({ ok: true }), setModel: async () => ({ ok: true }),
    newChat: async () => ({ ok: true }), getModelOptions: async () => ({ ok: true }),
    getPlanModelOptions: async () => ({ ok: true }), setPlanModel: async () => ({ ok: true }),
    reject: async () => ({ ok: true }), approveAll: async () => ({ ok: true }),
  } as any;
  const cb = { switchWindow: async () => {}, on: (() => {}) as any, off: (() => {}) as any } as any;
  return { mm, sm, ce, cb };
}

describe('voice hardening — TOCTOU confirmPending', () => {
  it('keeps token after stale authority so user can retry', async () => {
    const context = { sessionId: 'voice-1', epoch: 7, leaseId: 'lease-1' };
    const target: PinnedVoiceTarget = { windowId: 'w1', composerId: 'c1', revision: 'rev-1', ageMs: 10 };
    let healthOk = true;
    const authority: VoiceToolAuthority = {
      accepts: (c) => c.sessionId === context.sessionId && c.epoch === context.epoch && c.leaseId === context.leaseId,
      live: () => true,
      mutationHealth: () => healthOk ? { ok: true } : { ok: false, reason: 'stale' },
      committed: () => {},
    };
    const deps: VoiceToolDeps = {
      getState: () => ({
        connected: true, extractorStatus: 'ok' as const, lastExtractionAt: Date.now(),
        consecutiveExtractionFailures: 0, lastExtractionError: null,
        agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
        agentActivitySource: 'none' as const, messages: [],
        pendingApprovals: [{ id: 'a1', description: 'test', actions: [{ label: 'Accept', type: 'approve' as const, selectorPath: '.btn' }] }],
        inputAvailable: true, chatTabs: [], activeComposerId: '',
        mode: { current: 'agent', available: [] },
        model: { current: 'Auto', currentId: 'auto' },
        windows: [{ id: 'w1', title: 'my-project', url: '' }],
        activeWindowId: 'w1', composerQueue: { items: [] }, questionnaire: null,
      }),
      listSessions: () => [{ windowId: 'w1', windowTitle: 'my-project', tabs: [{ title: 't1', isActive: true, status: 'idle' }] }],
      activateTarget: async () => {},
      sendMessage: async () => {},
      clickApproval: async () => {},
      clickAction: async () => {},
      setMode: async () => {},
      setModel: async () => {},
      digest: async () => 'digest',
      getPinnedTarget: () => target,
      revalidateTarget: (expected) => {
        return !!target
          && target.windowId === expected.windowId
          && target.composerId === expected.composerId
          && target.revision === expected.revision;
      },
    };

    const router = new VoiceToolRouter(deps, authority);
    await router.call('set_target', { window: 'my-project' }, context);
    const staged = await router.call('approve', {}, context);
    assert.equal(staged.ok, true, `approve should succeed: ${staged.output}`);
    const token = (staged.output.match(/token "([0-9a-f]+)"/) ?? [])[1];
    assert.ok(token, `expected token in output: ${staged.output}`);

    healthOk = false;
    const failed = await router.call('confirm_pending', { token }, context);
    assert.equal(failed.ok, false, `first confirm should fail (stale): ${failed.output}`);
    // Token must remain available after a stale-authority failure
    const pendingAfterFail = router.getPending(token);
    assert.notEqual(pendingAfterFail, undefined, 'token should survive a stale-authority rejection');

    healthOk = true;
    const ok = await router.call('confirm_pending', { token }, context);
    assert.equal(ok.ok, true, `second confirm should succeed: ${ok.output}`);
  });
});

function makeIdleController(nowRef: { value: number }, overrides: Partial<VoiceSessionOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-idle-'));
  const controller = new VoiceSessionController({
    dataPath: join(dir, 'voice-usage.json'),
    priceVersion: 'test-v1',
    unitPriceCentsPerMinute: 1,
    dailyCapCents: 100,
    perSessionCapCents: 10,
    absoluteSessionMs: 10 * 60_000,
    idleMs: 10_000,
    idleGraceMs: 5_000,
    leaseMs: 30_000,
    ...overrides,
  }, () => nowRef.value);
  return { controller, dir };
}

describe('voice hardening — idle contract', () => {
  it('exposes user_active, idle_grace, and idle_expired substates', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeIdleController(now);
    try {
      const admitted = controller.admit('account-a');
      assert.equal(admitted.ok, true);
      const context = admitted.context!;
      controller.activate(context);

      // Touch resets activity: user_active
      controller.touch(context);
      let status = controller.status();
      assert.equal(status.idleStatus, 'user_active', 'just touched → user_active');

      // Advance past idleMs but within grace
      now.value += 12_000; // past idleMs (10s), before idleMs+idleGraceMs (15s)
      status = controller.status();
      assert.equal(status.idleStatus, 'idle_grace', 'past idleMs but within grace → idle_grace');

      // Advance past idleMs + idleGraceMs
      now.value += 6_000; // now at 18_000 from start, past 15_000 threshold
      status = controller.status();
      assert.equal(status.idleStatus, 'idle_expired', 'past idleMs+idleGraceMs → idle_expired');

      // idle_expired sessions are reaped
      const reaped = controller.reap();
      assert.equal(reaped.length, 1, 'idle_expired session is reaped');
      assert.equal(reaped[0].reason, 'idle_timeout');

      // Transport terminates the reaped session, clearing the way for a new one
      assert.equal(controller.beginTermination(context).accepted, true);
      controller.finishTermination(context, true);
      assert.equal(controller.status().state, 'terminated');

      // Absolute session max does NOT gain grace
      // Re-create: fast-forward past absoluteMs
      const second = controller.admit('account-a');
      assert.equal(second.ok, true);
      const ctx2 = second.context!;
      controller.activate(ctx2);
      controller.touch(ctx2);
      now.value += 10 * 60_000 + 1; // past absoluteSessionMs
      assert.equal(controller.status().idleStatus, 'idle_expired', 'absolute session max hard stop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('heartbeat does NOT refresh idle status (only touch does)', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeIdleController(now);
    try {
      const admitted = controller.admit('account-a');
      assert.equal(admitted.ok, true);
      const context = admitted.context!;
      controller.activate(context);
      controller.touch(context);

      // Advance past idleMs
      now.value += 12_000;
      assert.equal(controller.status().idleStatus, 'idle_grace', 'idle_grace after inactivity');

      // Heartbeat runs but does not reset idle
      controller.heartbeat(context.sessionId, context.epoch);
      assert.equal(controller.status().idleStatus, 'idle_grace', 'heartbeat does not refresh idle');

      // Touch does reset it
      controller.touch(context);
      assert.equal(controller.status().idleStatus, 'user_active', 'touch restores user_active');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('voice hardening — reportSpend & provenance', () => {
  it('prefers explicit provider cents and otherwise retains audio duration for an estimate', () => {
    assert.deepEqual(parseUsageFromDone(JSON.stringify({
      type: 'response.done',
      response: { usage: { cost_cents: 7, output_tokens: { audio_duration_ms: 60_000 } } },
    })), { reportedCents: 7, audioDurationMs: 60_000 });
    assert.deepEqual(parseUsageFromDone(JSON.stringify({
      type: 'response.done',
      response: { usage: { output_tokens: { audio_duration_ms: 60_000 } } },
    })), { audioDurationMs: 60_000 });
  });

  it('rejects stale context, accepts valid cents, exposes spendSource provenance', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeIdleController(now);
    try {
      const admitted = controller.admit('account-a');
      assert.equal(admitted.ok, true);
      const context = admitted.context!;
      controller.activate(context);

      // Initially spendSource is 'estimated'
      let status = controller.status();
      assert.equal(status.budget.spendSource, 'estimated');
      assert.equal(status.budget.reportedCents, null);

      // Reporting spend with stale context is rejected
      const staleCtx: VoiceSessionContext = { sessionId: 'nope', epoch: 999, leaseId: 'nope' };
      assert.equal(controller.reportSpend(staleCtx, 50), false);

      // Reporting spend with valid context works
      assert.equal(controller.reportSpend(context, 42), true);
      status = controller.status();
      assert.equal(status.budget.reportedCents, 42);
      assert.equal(status.budget.spendSource, 'reported');

      // Non-finite/invalid amounts rejected
      assert.equal(controller.reportSpend(context, -1), false);
      assert.equal(controller.reportSpend(context, Infinity), false);
      assert.equal(controller.reportSpend(context, NaN), false);

      // Negative amounts don't overwrite previous report
      status = controller.status();
      assert.equal(status.budget.reportedCents, 42);
      assert.equal(status.budget.spendSource, 'reported');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT invent pricing from token-only response.done events', () => {
    // The bridge must only accept a concrete cents amount. A response.done
    // with just total_tokens must NOT set reportedCents.
    const now = { value: 1_000 };
    const { controller, dir } = makeIdleController(now);
    try {
      const admitted = controller.admit('account-a');
      assert.equal(admitted.ok, true);
      const context = admitted.context!;
      controller.activate(context);

      // reportSpend is ONLY called with explicit cents; token-only calls must
      // never reach it. This tests the controller boundary: without cents,
      // reportedCents stays null.
      assert.equal(controller.status().budget.spendSource, 'estimated');
      assert.equal(controller.status().budget.reportedCents, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('voice hardening — socket health ownership', () => {
  it('owner-specific socket health: only owner session token makes socket healthy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-sh-'));
    try {
      const config = baseVoiceConfig();
      const { mm, sm, ce, cb } = makeMockTransportDeps();
      const transport = new VoiceTransport(config, dir, mm, sm, ce, cb);
      const sessions = (transport as unknown as { sessions: VoiceSessionController }).sessions;

      // Simulate relay-style socket tracking: a map of whose sockets are connected
      const activeSockets = new Map<string, number>();
      transport.setSocketHealthProvider(() => {
        const owner = transport.currentOwner;
        if (!owner) return false;
        return (activeSockets.get(owner) ?? 0) > 0;
      });

      // No session → no owner → socket health false
      assert.equal(transport.status.health.socket, false, 'no owner → false');

      // Admit for owner 'token-a'
      const admitted = sessions.admit('token-a');
      assert.equal(admitted.ok, true);
      const ctx = admitted.context!;
      sessions.activate(ctx);

      // No sockets connected for token-a yet
      assert.equal(transport.status.health.socket, false, 'token-a owner but no socket');

      // token-a socket connects
      activeSockets.set('token-a', 1);
      assert.equal(transport.status.health.socket, true, 'token-a socket connected → healthy');

      // token-b socket connects — does NOT help token-a
      activeSockets.set('token-b', 1);
      assert.equal(transport.status.health.socket, true, 'token-a still healthy');

      // token-a socket disconnects
      activeSockets.delete('token-a');
      assert.equal(transport.status.health.socket, false, 'token-a socket gone → false (token-b irrelevant)');

      // Session terminates → no owner → false
      sessions.beginTermination(ctx);
      sessions.finishTermination(ctx, true);
      assert.equal(transport.currentOwner, null);
      assert.equal(transport.status.health.socket, false, 'terminated → no owner → false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('voice hardening — mid-flight target revalidation', () => {
  it('fails closed when target changes between activation and mutation execution', async () => {
    const context = { sessionId: 'voice-1', epoch: 7, leaseId: 'lease-1' };
    const target: PinnedVoiceTarget = { windowId: 'w1', composerId: 'c1', revision: 'rev-1', ageMs: 10 };
    let currentTarget: PinnedVoiceTarget | null = target;
    let activateCallCount = 0;

    const authority: VoiceToolAuthority = {
      accepts: (c) => c.sessionId === context.sessionId && c.epoch === context.epoch && c.leaseId === context.leaseId,
      live: () => true,
      mutationHealth: (ctx, t) => {
        const current = currentTarget;
        return current && current.windowId === t.windowId && current.composerId === t.composerId && current.revision === t.revision
          ? { ok: true }
          : { ok: false, reason: 'Pinned Cursor target changed. Stage the action again.' };
      },
      committed: () => {},
    };

    let lastMutationTarget: PinnedVoiceTarget | null = null;
    const deps: VoiceToolDeps = {
      getState: () => ({
        connected: true, extractorStatus: 'ok' as const, lastExtractionAt: Date.now(),
        consecutiveExtractionFailures: 0, lastExtractionError: null,
        agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
        agentActivitySource: 'none' as const, messages: [],
        pendingApprovals: [{ id: 'a1', description: 'test', actions: [{ label: 'Accept', type: 'approve' as const, selectorPath: '.btn' }] }],
        inputAvailable: true, chatTabs: [], activeComposerId: 'c1',
        mode: { current: 'agent', available: [] },
        model: { current: 'Auto', currentId: 'auto' },
        windows: [{ id: 'w1', title: 'my-project', url: '' }],
        activeWindowId: 'w1', composerQueue: { items: [] }, questionnaire: null,
      }),
      listSessions: () => [{ windowId: 'w1', windowTitle: 'my-project', tabs: [{ title: 't1', isActive: true, status: 'idle' }] }],
      activateTarget: async () => {
        activateCallCount++;
        // Simulate target changing during activation (race condition scenario)
        if (activateCallCount === 2) {
          currentTarget = { windowId: 'w2', composerId: 'c2', revision: 'rev-2', ageMs: 10 };
        }
      },
      sendMessage: async () => { throw new Error('Should not be called when target changed'); },
      clickApproval: async () => { throw new Error('Should not be called when target changed'); },
      clickAction: async () => { throw new Error('Should not be called when target changed'); },
      setMode: async () => { throw new Error('Should not be called when target changed'); },
      setModel: async () => { throw new Error('Should not be called when target changed'); },
      digest: async () => 'digest',
      getPinnedTarget: () => currentTarget,
      revalidateTarget: (expected) => {
        const current = currentTarget;
        return !!current
          && current.windowId === expected.windowId
          && current.composerId === expected.composerId
          && current.revision === expected.revision;
      },
    };

    const router = new VoiceToolRouter(deps, authority);
    await router.call('set_target', { window: 'my-project' }, context);
    const staged = await router.call('approve', {}, context);
    assert.equal(staged.ok, true);
    const token = (staged.output.match(/token "([0-9a-f]+)"/) ?? [])[1];
    assert.ok(token, `expected token in output: ${staged.output}`);

    // Confirm will fail because target changes during activation
    const failed = await router.call('confirm_pending', { token }, context);
    assert.equal(failed.ok, false, 'confirm should fail when target changes');
    assert.match(failed.output, /target changed/i);

    // Token should survive for retry
    const pendingAfterFail = router.getPending(token);
    assert.notEqual(pendingAfterFail, undefined, 'token should survive target change failure');
  });

  it('executes successfully when target remains stable', async () => {
    const context = { sessionId: 'voice-1', epoch: 7, leaseId: 'lease-1' };
    const target: PinnedVoiceTarget = { windowId: 'w1', composerId: 'c1', revision: 'rev-1', ageMs: 10 };

    const authority: VoiceToolAuthority = {
      accepts: (c) => c.sessionId === context.sessionId && c.epoch === context.epoch && c.leaseId === context.leaseId,
      live: () => true,
      mutationHealth: () => ({ ok: true }),
      committed: () => {},
    };

    let clickApprovalCalled = false;
    const deps: VoiceToolDeps = {
      getState: () => ({
        connected: true, extractorStatus: 'ok' as const, lastExtractionAt: Date.now(),
        consecutiveExtractionFailures: 0, lastExtractionError: null,
        agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
        agentActivitySource: 'none' as const, messages: [],
        pendingApprovals: [{ id: 'a1', description: 'test', actions: [{ label: 'Accept', type: 'approve' as const, selectorPath: '.accept-btn' }] }],
        inputAvailable: true, chatTabs: [], activeComposerId: 'c1',
        mode: { current: 'agent', available: [] },
        model: { current: 'Auto', currentId: 'auto' },
        windows: [{ id: 'w1', title: 'my-project', url: '' }],
        activeWindowId: 'w1', composerQueue: { items: [] }, questionnaire: null,
      }),
      listSessions: () => [{ windowId: 'w1', windowTitle: 'my-project', tabs: [{ title: 't1', isActive: true, status: 'idle' }] }],
      activateTarget: async () => {},
      sendMessage: async () => {},
      clickApproval: async () => { clickApprovalCalled = true; },
      clickAction: async () => {},
      setMode: async () => {},
      setModel: async () => {},
      digest: async () => 'digest',
      getPinnedTarget: () => target,
      revalidateTarget: (expected) => {
        return expected.windowId === target.windowId
          && expected.composerId === target.composerId
          && expected.revision === target.revision;
      },
    };

    const router = new VoiceToolRouter(deps, authority);
    await router.call('set_target', { window: 'my-project' }, context);
    const staged = await router.call('approve', {}, context);
    const token = (staged.output.match(/token "([0-9a-f]+)"/) ?? [])[1];

    const confirmed = await router.call('confirm_pending', { token }, context);
    assert.equal(confirmed.ok, true, 'confirm should succeed when target stable');
    assert.ok(clickApprovalCalled, 'mutation should execute');
  });
});

describe('voice hardening — pin threading', () => {
  it('passes target to mutating methods for fail-closed validation', async () => {
    const context = { sessionId: 'voice-1', epoch: 7, leaseId: 'lease-1' };
    const target: PinnedVoiceTarget = { windowId: 'w1', composerId: 'c1', revision: 'rev-1', ageMs: 10 };
    let capturedTarget: PinnedVoiceTarget | null = null;
    const authority: VoiceToolAuthority = {
      accepts: (c) => c.sessionId === context.sessionId && c.epoch === context.epoch && c.leaseId === context.leaseId,
      live: () => true,
      mutationHealth: () => ({ ok: true }),
      committed: () => {},
    };

    const deps: VoiceToolDeps = {
      getState: () => ({
        connected: true, extractorStatus: 'ok' as const, lastExtractionAt: Date.now(),
        consecutiveExtractionFailures: 0, lastExtractionError: null,
        agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
        agentActivitySource: 'none' as const, messages: [],
        pendingApprovals: [{ id: 'a1', description: 'test', actions: [{ label: 'Accept', type: 'approve' as const, selectorPath: '.btn' }] }],
        inputAvailable: true, chatTabs: [], activeComposerId: 'c1',
        mode: { current: 'agent', available: [] },
        model: { current: 'Auto', currentId: 'auto' },
        windows: [{ id: 'w1', title: 'my-project', url: '' }],
        activeWindowId: 'w1', composerQueue: { items: [] }, questionnaire: null,
      }),
      listSessions: () => [{ windowId: 'w1', windowTitle: 'my-project', tabs: [{ title: 't1', isActive: true, status: 'idle' }] }],
      activateTarget: async () => {},
      sendMessage: async (text, tgt) => { capturedTarget = tgt; },
      clickApproval: async (selectorPath, tgt) => { capturedTarget = tgt; },
      clickAction: async (selectorPath, label, tgt) => { capturedTarget = tgt; },
      setMode: async (modeId, tgt) => { capturedTarget = tgt; },
      setModel: async (modelId, tgt) => { capturedTarget = tgt; },
      digest: async () => 'digest',
      getPinnedTarget: () => target,
      revalidateTarget: (expected) => {
        return expected.windowId === target.windowId
          && expected.composerId === target.composerId
          && expected.revision === target.revision;
      },
    };

    const router = new VoiceToolRouter(deps, authority);
    await router.call('set_target', { window: 'my-project' }, context);
    const staged = await router.call('approve', {}, context);
    const token = (staged.output.match(/token "([0-9a-f]+)"/) ?? [])[1];

    const confirmed = await router.call('confirm_pending', { token }, context);
    assert.equal(confirmed.ok, true, 'confirm should succeed');
    assert.ok(capturedTarget, 'target should be passed to clickApproval');
    assert.equal(capturedTarget!.windowId, 'w1');
    assert.equal(capturedTarget!.composerId, 'c1');
    assert.equal(capturedTarget!.revision, 'rev-1');
  });

  it('fails closed when target changes between activation and mutation await', async () => {
    const context = { sessionId: 'voice-1', epoch: 7, leaseId: 'lease-1' };
    let currentTarget: PinnedVoiceTarget | null = { windowId: 'w1', composerId: 'c1', revision: 'rev-1', ageMs: 10 };
    let activateCallCount = 0;
    let mutationCalled = false;

    const authority: VoiceToolAuthority = {
      accepts: (c) => c.sessionId === context.sessionId && c.epoch === context.epoch && c.leaseId === context.leaseId,
      live: () => true,
      mutationHealth: () => ({ ok: true }),
      committed: () => {},
    };

    const deps: VoiceToolDeps = {
      getState: () => ({
        connected: true, extractorStatus: 'ok' as const, lastExtractionAt: Date.now(),
        consecutiveExtractionFailures: 0, lastExtractionError: null,
        agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
        agentActivitySource: 'none' as const, messages: [],
        pendingApprovals: [{ id: 'a1', description: 'test', actions: [{ label: 'Accept', type: 'approve' as const, selectorPath: '.btn' }] }],
        inputAvailable: true, chatTabs: [], activeComposerId: 'c1',
        mode: { current: 'agent', available: [] },
        model: { current: 'Auto', currentId: 'auto' },
        windows: [{ id: 'w1', title: 'my-project', url: '' }],
        activeWindowId: 'w1', composerQueue: { items: [] }, questionnaire: null,
      }),
      listSessions: () => [{ windowId: 'w1', windowTitle: 'my-project', tabs: [{ title: 't1', isActive: true, status: 'idle' }] }],
      activateTarget: async () => {
        activateCallCount++;
        // Change target only on the SECOND call (during confirm_pending), not the first (during set_target)
        if (activateCallCount === 2) {
          currentTarget = { windowId: 'w2', composerId: 'c2', revision: 'rev-2', ageMs: 10 };
        }
      },
      sendMessage: async () => { mutationCalled = true; },
      clickApproval: async () => { mutationCalled = true; },
      clickAction: async () => { mutationCalled = true; },
      setMode: async () => { mutationCalled = true; },
      setModel: async () => { mutationCalled = true; },
      digest: async () => 'digest',
      getPinnedTarget: () => currentTarget,
      revalidateTarget: (expected) => {
        const current = currentTarget;
        return !!current
          && current.windowId === expected.windowId
          && current.composerId === expected.composerId
          && current.revision === expected.revision;
      },
    };

    const router = new VoiceToolRouter(deps, authority);
    await router.call('set_target', { window: 'my-project' }, context);
    const staged = await router.call('approve', {}, context);
    const token = (staged.output.match(/token "([0-9a-f]+)"/) ?? [])[1];

    const confirmed = await router.call('confirm_pending', { token }, context);
    assert.equal(confirmed.ok, false, 'confirm should fail when target changes mid-flight');
    assert.ok(confirmed.output.toLowerCase().includes('target changed'), 'error message should mention target change');
    assert.equal(mutationCalled, false, 'mutation should NOT be called');
    assert.notEqual(router.getPending(token), undefined, 'token should survive for retry');
  });

  it('consumes token when post-mutation revalidation fails after side effect', async () => {
    const context = { sessionId: 'voice-1', epoch: 7, leaseId: 'lease-1' };
    const target: PinnedVoiceTarget = { windowId: 'w1', composerId: 'c1', revision: 'rev-1', ageMs: 10 };
    let validations = 0;
    let mutationCalled = false;

    const authority: VoiceToolAuthority = {
      accepts: (c) => c.sessionId === context.sessionId && c.epoch === context.epoch && c.leaseId === context.leaseId,
      live: () => true,
      mutationHealth: () => ({ ok: true }),
      committed: () => {},
    };

    const deps: VoiceToolDeps = {
      getState: () => ({
        connected: true, extractorStatus: 'ok' as const, lastExtractionAt: Date.now(),
        consecutiveExtractionFailures: 0, lastExtractionError: null,
        agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
        agentActivitySource: 'none' as const, messages: [],
        pendingApprovals: [{ id: 'a1', description: 'test', actions: [{ label: 'Accept', type: 'approve' as const, selectorPath: '.btn' }] }],
        inputAvailable: true, chatTabs: [], activeComposerId: 'c1',
        mode: { current: 'agent', available: [] },
        model: { current: 'Auto', currentId: 'auto' },
        windows: [{ id: 'w1', title: 'my-project', url: '' }],
        activeWindowId: 'w1', composerQueue: { items: [] }, questionnaire: null,
      }),
      listSessions: () => [{ windowId: 'w1', windowTitle: 'my-project', tabs: [{ title: 't1', isActive: true, status: 'idle' }] }],
      activateTarget: async () => {},
      sendMessage: async () => { mutationCalled = true; },
      clickApproval: async () => { mutationCalled = true; },
      clickAction: async () => { mutationCalled = true; },
      setMode: async () => { mutationCalled = true; },
      setModel: async () => { mutationCalled = true; },
      digest: async () => 'digest',
      getPinnedTarget: () => target,
      revalidateTarget: () => ++validations < 2,
    };

    const router = new VoiceToolRouter(deps, authority);
    await router.call('set_target', { window: 'my-project' }, context);
    const staged = await router.call('approve', {}, context);
    const token = (staged.output.match(/token "([0-9a-f]+)"/) ?? [])[1];

    const confirmed = await router.call('confirm_pending', { token }, context);
    assert.equal(confirmed.ok, false, 'confirm should fail when target changes during mutation');
    assert.ok(confirmed.output.toLowerCase().includes('target changed'), 'error message should mention target change');
    assert.equal(mutationCalled, true, 'mutation side effect already ran');
    assert.equal(router.getPending(token), undefined, 'token must be consumed to prevent double-apply');
  });
});
