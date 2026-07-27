import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { VoiceSessionController } from '../src/server/transports/voice/session.js';
import { VoiceTransport } from '../src/server/transports/voice/index.js';
import type { VoiceConfig } from '../src/server/types.js';

function makeController(nowRef: { value: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-own-'));
  const controller = new VoiceSessionController({
    dataPath: join(dir, 'voice-usage.json'),
    priceVersion: 'test-v1',
    unitPriceCentsPerMinute: 1,
    dailyCapCents: 100,
    perSessionCapCents: 10,
    absoluteSessionMs: 10 * 60_000,
    idleMs: 60_000,
    idleGraceMs: 5_000,
    leaseMs: 30_000,
  }, () => nowRef.value);
  return { controller, dir };
}

describe('voice account ownership boundary', () => {
  it('currentOwner returns accountKey from admit and null after termination (controller-level proof)', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now);
    try {
      // Initially idle → no owner
      assert.equal(controller.currentOwner(), null, 'idle controller has no owner');

      // Account A creates a session
      const admittedA = controller.admit('account-a');
      assert.equal(admittedA.ok, true);
      const ctxA = admittedA.context!;

      // currentOwner must return 'account-a'
      assert.equal(controller.currentOwner(), 'account-a', 'owner is account-a after admit');

      // Activate so lifecycle ops work
      assert.equal(controller.activate(ctxA), true);
      assert.equal(controller.accept(ctxA), true);

      // Account B is NOT the owner
      // (this is the check the transport will use: currentOwner() !== caller's key)
      assert.equal(controller.currentOwner(), 'account-a');
      assert.notEqual(controller.currentOwner(), 'account-b');

      // A remains live
      assert.equal(controller.heartbeat(ctxA.sessionId, ctxA.epoch), true, 'A can heartbeat own session');
      assert.equal(controller.accept(ctxA), true, 'A can accept own session');

      // After termination, owner is null
      controller.beginTermination(ctxA);
      controller.finishTermination(ctxA, true);
      assert.equal(controller.currentOwner(), null, 'owner null after termination');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proves live session A cannot be operated by account B', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-own2-'));
    try {
      const baseConfig: VoiceConfig = {
        enabled: true,
        openaiApiKey: 'sk-test-fake-do-not-use',
        model: 'gpt-4o-realtime-preview',
        miniModel: '',
        voice: 'marin',
        openrouterApiKey: 'sk-or-test-fake',
        digestModel: 'test-model',
        ttsModel: 'test-tts',
        sttModel: 'test-stt',
        proactiveMinIntervalMs: 15000,
        usagePriceVersion: 'test-v1',
        usageUnitPriceCentsPerMinute: 1,
        dailyCapCents: 100,
        perSessionCapCents: 10,
        absoluteSessionMs: 10 * 60_000,
        idleMs: 60_000,
        idleGraceMs: 5_000,
        leaseMs: 30_000,
        targetMaxAgeMs: 5000,
      };

      function makeMockTransport(dataDir: string) {
        const mm = new EventEmitter() as any;
        mm.on = mm.on.bind(mm);
        const sm = Object.assign(new EventEmitter(), {
          getCurrentState: () => ({
            connected: false, extractorStatus: 'idle', lastExtractionAt: null,
            consecutiveExtractionFailures: 0, lastExtractionError: null,
            agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
            agentActivitySource: 'none' as const, messages: [], pendingApprovals: [],
            inputAvailable: false, chatTabs: [], activeComposerId: '',
            mode: { current: '', available: [] }, model: { current: '', currentId: '' },
            windows: [], activeWindowId: '', composerQueue: { items: [] }, questionnaire: null,
          }),
          generation: 0,
          on: (() => {}) as any,
          off: (() => {}) as any,
        });
        const ce = { sendMessage: async () => ({ ok: true }), switchTab: async () => ({ ok: true }), clickApproval: async () => ({ ok: true }), clickAction: async () => ({ ok: true }), setMode: async () => ({ ok: true }), setModel: async () => ({ ok: true }), newChat: async () => ({ ok: true }), getModelOptions: async () => ({ ok: true }), getPlanModelOptions: async () => ({ ok: true }), setPlanModel: async () => ({ ok: true }), reject: async () => ({ ok: true }), approveAll: async () => ({ ok: true }) } as any;
        const cb = { switchWindow: async () => {}, on: (() => {}) as any, off: (() => {}) as any } as any;
        const t = new VoiceTransport(baseConfig, dataDir, mm, sm, ce, cb);
        return t;
      }

      const transport = makeMockTransport(dir);

      // Seed a live session for account A via the private sessions controller
      // (runtime type cast — no production API added for tests)
      const sessions = (transport as unknown as { sessions: VoiceSessionController }).sessions;
      const admitted = sessions.admit('account-a');
      assert.equal(admitted.ok, true, 'A session admitted');
      const ctxA = admitted.context!;
      const { sessionId, epoch } = ctxA;

      // Session is in 'admitting' state. B cannot attachCall
      // (assertOwner fires before the activate check)
      await assert.rejects(
        () => transport.attachCall('call-attach-by-b', undefined, sessionId, epoch, 'account-b'),
        (err: any) => err?.statusCode === 403,
        'B attachCall throws 403 on owning session'
      );

      // Activate A's session so heartbeat/terminate can reach the owner check
      assert.equal(sessions.activate(ctxA), true, 'A session activated');

      // B cannot heartbeat
      assert.equal(transport.heartbeat(sessionId, epoch, 'account-b'), false,
        'B heartbeat returns false (non-disclosing)');

      // B cannot terminate
      await assert.rejects(
        () => transport.terminate(sessionId, epoch, 'test-by-b', 'account-b'),
        (err: any) => err?.statusCode === 403,
        'B terminate throws 403'
      );

      // B cannot read live status
      assert.equal(transport.statusFor('account-b'), null,
        'B statusFor returns null');

      // Meanwhile A remains live and can heartbeat own session
      assert.equal(transport.heartbeat(sessionId, epoch, 'account-a'), true,
        'A can heartbeat own session');

      // A sees own session status (not null)
      const aStatus = transport.statusFor('account-a');
      assert.notEqual(aStatus, null, 'A statusFor returns data');
      assert.equal(aStatus?.sessionId, sessionId, 'A sees own sessionId');

      // no-auth path (owner undefined) still falls through to existing behaviour
      assert.equal(transport.heartbeat(sessionId, epoch, undefined), true,
        'no-auth heartbeat still works');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the cached termination to its owner after the session releases ownership', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-own3-'));
    try {
      const baseConfig: VoiceConfig = {
        enabled: true,
        openaiApiKey: 'sk-test-fake-do-not-use',
        model: 'gpt-4o-realtime-preview',
        miniModel: '',
        voice: 'marin',
        openrouterApiKey: 'sk-or-test-fake',
        digestModel: 'test-model',
        ttsModel: 'test-tts',
        sttModel: 'test-stt',
        proactiveMinIntervalMs: 15000,
        usagePriceVersion: 'test-v1',
        usageUnitPriceCentsPerMinute: 1,
        dailyCapCents: 100,
        perSessionCapCents: 10,
        absoluteSessionMs: 10 * 60_000,
        idleMs: 60_000,
        idleGraceMs: 5_000,
        leaseMs: 30_000,
        targetMaxAgeMs: 5000,
      };
      const mm = new EventEmitter() as any;
      const sm = Object.assign(new EventEmitter(), {
        getCurrentState: () => ({
          connected: false, extractorStatus: 'idle', lastExtractionAt: null,
          consecutiveExtractionFailures: 0, lastExtractionError: null,
          agentStatus: 'idle' as const, agentActivityText: null, agentActivityLive: false,
          agentActivitySource: 'none' as const, messages: [], pendingApprovals: [],
          inputAvailable: false, chatTabs: [], activeComposerId: '',
          mode: { current: '', available: [] }, model: { current: '', currentId: '' },
          windows: [], activeWindowId: '', composerQueue: { items: [] }, questionnaire: null,
        }),
        generation: 0,
        on: (() => {}) as any,
        off: (() => {}) as any,
      });
      const ce = {} as any;
      const cb = {} as any;
      const transport = new VoiceTransport(baseConfig, dir, mm, sm, ce, cb);
      const sessions = (transport as unknown as { sessions: VoiceSessionController }).sessions;
      const admitted = sessions.admit('account-a');
      assert.equal(admitted.ok, true);
      const context = admitted.context!;
      assert.equal(sessions.activate(context), true);

      const first = await transport.terminate(context.sessionId, context.epoch, 'client_request', 'account-a');
      const repeat = await transport.terminate(context.sessionId, context.epoch, 'client_request', 'account-a');

      assert.deepEqual(repeat, first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
