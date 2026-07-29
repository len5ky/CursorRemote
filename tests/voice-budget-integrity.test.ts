import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { VoiceSessionController } from '../src/server/transports/voice/session.js';
import { RealtimeBridge } from '../src/server/transports/voice/realtime-bridge.js';
import { VoiceToolRouter } from '../src/server/transports/voice/tools.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { KNOWN_VOICE_PRICE_VERSION } from '../src/server/transports/voice/pricing.js';
import { FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';

/**
 * Two independent accounting defects, both of which let real spend escape the
 * caps the operator configured.
 *
 * 1. `response.done` usage is reported by the provider **per response**, not
 *    cumulatively. Overwriting the running total with the latest response meant
 *    a call that cost 30 then 40 settled as 40. The daily ledger — the thing
 *    that survives a restart — undercounted every multi-response call.
 *
 * 2. The budget account was the web session token. Logging out and back in
 *    minted a new token, which hashed to a brand new ledger account, which had
 *    a brand new daily cap. The daily cap was one login away from being
 *    unlimited.
 */

const harnesses: VoiceRelayHarness[] = [];
after(async () => {
  for (const harness of harnesses) await harness.close();
});

async function track(pending: Promise<VoiceRelayHarness>): Promise<VoiceRelayHarness> {
  const resolved = await pending;
  harnesses.push(resolved);
  return resolved;
}

function makeController(nowRef: { value: number }, overrides: Partial<ConstructorParameters<typeof VoiceSessionController>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-budget-integrity-'));
  const controller = new VoiceSessionController({
    dataPath: join(dir, 'voice-usage.json'),
    priceVersion: KNOWN_VOICE_PRICE_VERSION,
    unitPriceCentsPerMinute: 1,
    dailyCapCents: 1_000,
    perSessionCapCents: 500,
    absoluteSessionMs: 10 * 60_000,
    idleMs: 60_000,
    idleGraceMs: 5_000,
    leaseMs: 30_000,
    ...overrides,
  }, () => nowRef.value);
  return { controller, dir };
}

describe('voice usage settlement — per-response provider costs accumulate', () => {
  it('settles the sum of every reported response cost, not the last one', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now);
    try {
      const admitted = controller.admit('owner-a');
      const context = admitted.context!;
      controller.activate(context);

      assert.equal(controller.reportSpend(context, 30, 'reported'), true);
      assert.equal(controller.reportSpend(context, 40, 'reported'), true);
      assert.equal(controller.status().budget.reportedCents, 70, 'per-response costs accumulate');

      controller.beginTermination(context);
      controller.finishTermination(context, true);

      assert.equal(
        controller.status().budget.dailyTotalCents,
        70,
        'the durable ledger must record every response the provider billed',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accumulates locally priced per-response estimates too', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now);
    try {
      const context = controller.admit('owner-a').context!;
      controller.activate(context);

      controller.reportSpend(context, 5, 'estimated');
      controller.reportSpend(context, 5, 'estimated');
      assert.ok(
        controller.status().budget.estimatedCents >= 10,
        'two estimated responses cost more than one, never the same',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never settles below what the live cap was already enforcing', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now);
    try {
      const context = controller.admit('owner-a').context!;
      controller.activate(context);

      // Wall-clock estimate outruns the single tiny reported cost.
      now.value += 4 * 60_000;
      controller.reportSpend(context, 1, 'reported');
      const liveSpend = Math.max(
        controller.status().budget.estimatedCents,
        controller.status().budget.reportedCents ?? 0,
      );

      controller.beginTermination(context);
      controller.finishTermination(context, true);

      assert.ok(
        controller.status().budget.dailyTotalCents >= liveSpend,
        'settlement must not undercount what the live budget already charged',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports each provider response separately from the sideband', async () => {
    const reported: number[] = [];
    const context: VoiceSessionContext = { sessionId: 'session-1', epoch: 1, leaseId: 'lease-1' };
    const socket = new FakeRealtimeSocket();
    const bridge = new RealtimeBridge(testVoiceConfig(), {} as VoiceToolRouter, {
      accepts: () => true,
      userTurn: () => {},
      providerFailure: () => {},
      reportSpend: (_context, cents, source) => { if (source === 'reported') reported.push(cents); return true; },
    }, { websocketFactory: () => socket as unknown as WebSocket });

    await bridge.attachSideband('call-1', context);
    socket.emit('message', JSON.stringify({ type: 'response.done', response: { usage: { cost_cents: 30 } } }));
    socket.emit('message', JSON.stringify({ type: 'response.done', response: { usage: { cost_cents: 40 } } }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(reported, [30, 40], 'each response.done is its own per-response cost');
  });
});

describe('voice budget account — stable across logins', () => {
  it('keeps one durable account when the owner key changes', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now);
    try {
      const first = controller.admit('login-token-a', 'operator').context!;
      controller.activate(first);
      controller.reportSpend(first, 25, 'reported');
      controller.beginTermination(first);
      controller.finishTermination(first, true);

      const second = controller.admit('login-token-b', 'operator').context!;
      controller.activate(second);

      assert.equal(
        controller.status().budget.dailyTotalCents,
        25,
        'a fresh login token must not reset the operator daily quota',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps ownership separate from the budget account', () => {
    const now = { value: 1_000 };
    const { controller, dir } = makeController(now);
    try {
      const context = controller.admit('login-token-a', 'operator').context!;
      assert.equal(controller.currentOwner(), 'login-token-a', 'authorization still follows the session token');
      assert.equal(controller.sessionOwner(), 'login-token-a');
      assert.ok(context);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes exactly one ledger account across two real logins', async () => {
    const harness = await track(startVoiceRelay({ password: 'budget-account-password' }));

    for (let round = 0; round < 2; round++) {
      const cookie = await harness.login();
      const minted = await harness.raw({
        method: 'POST',
        path: '/api/voice/token',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(minted.status, 200, `mint ${round} must succeed`);
      const body = JSON.parse(minted.body) as { sessionId: string; epoch: number };

      const ended = await harness.raw({
        method: 'POST',
        path: '/api/voice/terminate',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: body.sessionId, epoch: body.epoch }),
      });
      assert.equal(ended.status, 200, `terminate ${round} must succeed`);
    }

    const ledger = JSON.parse(
      readFileSync(join(harness.dataDir, 'voice-usage.json'), 'utf-8'),
    ) as { accounts: Record<string, unknown> };

    assert.equal(
      Object.keys(ledger.accounts).length,
      1,
      're-logging in must not create a second ledger account with a fresh daily cap',
    );
  });

  it('never returns or logs the raw budget account identity', async () => {
    const harness = await track(startVoiceRelay({
      password: 'budget-account-password',
      accountId: 'operator-identity-secret',
    }));
    const cookie = await harness.login();

    const logged: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const capture = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    console.log = capture; console.warn = capture; console.error = capture;
    let minted: { status: number; body: string };
    let status: { status: number; body: string };
    try {
      minted = await harness.raw({
        method: 'POST',
        path: '/api/voice/token',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      status = await harness.raw({ path: '/api/voice/status', headers: { Cookie: cookie } });
    } finally {
      console.log = originalLog; console.warn = originalWarn; console.error = originalError;
    }

    assert.equal(minted.status, 200);
    assert.ok(!minted.body.includes('operator-identity-secret'), 'the mint response must not carry the account id');
    assert.ok(!status.body.includes('operator-identity-secret'), 'the status response must not carry the account id');
    for (const line of logged) {
      assert.ok(!line.includes('operator-identity-secret'), `the account id must stay out of logs: ${line}`);
    }

    const ledger = readFileSync(join(harness.dataDir, 'voice-usage.json'), 'utf-8');
    assert.ok(!ledger.includes('operator-identity-secret'), 'the ledger stores a hash, never the raw account id');
  });
});
