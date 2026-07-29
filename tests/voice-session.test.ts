import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceSessionController, VoiceUsageLedger } from '../src/server/transports/voice/session.js';
import { KNOWN_VOICE_PRICE_VERSION } from '../src/server/transports/voice/pricing.js';

function makeController(nowRef: { value: number }, overrides: Partial<ConstructorParameters<typeof VoiceSessionController>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-'));
  const controller = new VoiceSessionController({
    dataPath: join(dir, 'voice-usage.json'),
    priceVersion: KNOWN_VOICE_PRICE_VERSION,
    unitPriceCentsPerMinute: 1,
    dailyCapCents: 20,
    perSessionCapCents: 10,
    absoluteSessionMs: 10 * 60_000,
    idleMs: 60_000,
    idleGraceMs: 5_000,
    leaseMs: 30_000,
    ...overrides,
  }, () => nowRef.value);
  return { controller, dir };
}

describe('voice session lifecycle', () => {
  it('rejects stale events and never resurrects a terminated epoch', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now);
    try {
      const admitted = controller.admit('account-a');
      assert.equal(admitted.ok, true);
      assert.ok(admitted.context);
      const context = admitted.context!;

      assert.equal(controller.activate(context), true);
      assert.equal(controller.accept(context), true);
      assert.equal(controller.accept({ ...context, epoch: context.epoch + 1 }), false);

      assert.equal(controller.beginTermination(context).accepted, true);
      controller.finishTermination(context, true);

      assert.equal(controller.accept(context), false);
      assert.equal(controller.status().state, 'terminated');
      assert.equal(controller.beginTermination(context).accepted, false);
      assert.equal(controller.status().state, 'terminated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reaps expired leases and reports hard budget exhaustion', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now);
    try {
      const admitted = controller.admit('account-a');
      assert.equal(admitted.ok, true);
      const context = admitted.context!;
      controller.activate(context);

      now.value += 30_001;
      assert.deepEqual(controller.reap(), [{ context, reason: 'lease_expired' }]);
      assert.equal(controller.beginTermination(context).accepted, true);
      controller.finishTermination(context, false);
      assert.equal(controller.status().budget.dailyTotalCents, 1, 'termination settles accrued usage after lease expiry');

      const next = controller.admit('account-a');
      assert.equal(next.ok, true);
      const nextContext = next.context!;
      controller.activate(nextContext);
      now.value += 10 * 60_000;
      assert.deepEqual(controller.reap(), [{ context: nextContext, reason: 'hard_exceeded' }]);
      assert.equal(controller.status().budget.state, 'hard_exceeded');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('voice usage admission', () => {
  it('requires known versioned pricing and reserves the per-session cap', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now, { priceVersion: '', unitPriceCentsPerMinute: 0 });
    try {
      assert.match(controller.admit('account-a').error ?? '', /pricing/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const ledgerDir = mkdtempSync(join(tmpdir(), 'cursor-remote-voice-'));
    try {
      const ledger = new VoiceUsageLedger(join(ledgerDir, 'voice-usage.json'));
      ledger.reserve('one', 'account-a', now.value, 10, 10, now.value + 60_000);
      assert.throws(
        () => ledger.reserve('two', 'account-a', now.value, 1, 10, now.value + 60_000),
        /daily budget/i
      );
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }

    const corrupt = makeController(now);
    try {
      writeFileSync(join(corrupt.dir, 'voice-usage.json'), '{not json');
      assert.match(corrupt.controller.admit('account-a').error ?? '', /ledger/i);
    } finally {
      rmSync(corrupt.dir, { recursive: true, force: true });
    }
  });
});
