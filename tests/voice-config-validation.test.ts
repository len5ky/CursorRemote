import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, readIntegerEnv } from '../src/server/config.js';
import {
  KNOWN_VOICE_PRICE_VERSION,
  VOICE_PRICE_TABLE,
  isKnownVoicePriceVersion,
  knownVoicePriceVersions,
} from '../src/server/transports/voice/pricing.js';
import { VoiceSessionController } from '../src/server/transports/voice/session.js';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';

/**
 * "Known versioned pricing is required for admission" was enforced as "the
 * operator typed something non-empty". Any invented string satisfied it, so the
 * documented invariant — that a paid session is only ever admitted against a
 * price the code actually knows — was decorative.
 *
 * The same applies to every numeric knob: `parseInt('abc', 10)` is `NaN`, and a
 * `NaN` cap silently disables the cap it was supposed to enforce.
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

const MANAGED_ENV = [
  'SERVER_PORT', 'POLL_INTERVAL_MS', 'DEBOUNCE_MS', 'WEBAPP_PASSWORD', 'DATA_DIR',
  'VOICE_ENABLED', 'VOICE_MODEL', 'VOICE_PUBLIC_ORIGIN', 'VOICE_ACCOUNT_ID',
  'VOICE_USAGE_PRICE_VERSION', 'VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE',
  'VOICE_USAGE_DAILY_CAP_CENTS', 'VOICE_USAGE_PER_SESSION_CAP_CENTS',
  'VOICE_SESSION_ABSOLUTE_MS', 'VOICE_SESSION_IDLE_MS', 'VOICE_SESSION_IDLE_GRACE_MS',
  'VOICE_SESSION_LEASE_MS', 'VOICE_TARGET_MAX_AGE_MS', 'TAILSCALE_SERVE_IDENTITY',
] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, saved.has(key) ? saved.get(key) : process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('voice pricing — a frozen table of known price versions', () => {
  it('exposes an immutable table and rejects anything not in it', () => {
    assert.ok(Object.isFrozen(VOICE_PRICE_TABLE), 'the price table must not be mutable at runtime');
    assert.ok(knownVoicePriceVersions().length > 0);
    assert.ok(knownVoicePriceVersions().includes(KNOWN_VOICE_PRICE_VERSION));

    assert.equal(isKnownVoicePriceVersion(KNOWN_VOICE_PRICE_VERSION), true);
    for (const invented of ['', '   ', 'operator-invented-2099-99', 'openai-realtime', 'OPENAI-REALTIME-2026-01']) {
      assert.equal(isKnownVoicePriceVersion(invented), false, `"${invented}" is not a known price version`);
    }
  });

  it('refuses admission for an unknown price version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-pricing-'));
    try {
      const controller = new VoiceSessionController({
        dataPath: join(dir, 'voice-usage.json'),
        priceVersion: 'operator-invented-2099-99',
        unitPriceCentsPerMinute: 1,
        dailyCapCents: 100,
        perSessionCapCents: 10,
        absoluteSessionMs: 60_000,
        idleMs: 60_000,
        idleGraceMs: 5_000,
        leaseMs: 30_000,
      }, () => 1_000);
      const admitted = controller.admit('owner-a');
      assert.equal(admitted.ok, false);
      assert.match(admitted.error ?? '', /pricing/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to mint a paid session over HTTP under an invented price version', async () => {
    const harness = await track(startVoiceRelay({
      password: 'pricing-password',
      priceVersion: 'operator-invented-2099-99',
    }));
    const cookie = await harness.login();

    const minted = await harness.raw({
      method: 'POST',
      path: '/api/voice/token',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });

    assert.notEqual(minted.status, 200, 'an unknown price version must never admit a paid session');
    assert.ok(!minted.body.includes('clientSecret'), 'no provider credential is minted');
    assert.ok(harness.providerCalls.length === 0, 'the provider is never contacted for an unpriced session');
  });
});

describe('numeric configuration — finite values inside declared ranges', () => {
  it('rejects anything that is not an integer in range', () => {
    const spec = { min: 1, max: 100, fallback: 10 };
    assert.equal(readIntegerEnv({}, 'X', spec), 10, 'an absent value uses the documented default');
    assert.equal(readIntegerEnv({ X: '42' }, 'X', spec), 42);

    for (const bad of ['', '   ', 'abc', 'NaN', 'Infinity', '1e3', '4.5', '0', '101', '-1', '0x10', '12abc']) {
      assert.throws(
        () => readIntegerEnv({ X: bad }, 'X', spec),
        /X/,
        `"${bad}" must be refused rather than silently coerced`,
      );
    }
  });

  it('fails startup for an out-of-range or unparsable numeric env var', () => {
    for (const [key, value] of [
      ['SERVER_PORT', '0'],
      ['SERVER_PORT', '70000'],
      ['SERVER_PORT', 'abc'],
      ['POLL_INTERVAL_MS', '-1'],
      ['VOICE_USAGE_DAILY_CAP_CENTS', 'abc'],
      ['VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE', '0'],
      ['VOICE_SESSION_LEASE_MS', 'NaN'],
    ] as Array<[string, string]>) {
      assert.throws(
        () => withEnv({ WEBAPP_PASSWORD: 'x', [key]: value }, () => loadConfig()),
        new RegExp(key),
        `${key}=${value} must fail startup`,
      );
    }
  });

  it('fails startup when the per-session cap exceeds the daily cap', () => {
    assert.throws(
      () => withEnv({
        WEBAPP_PASSWORD: 'x',
        VOICE_USAGE_DAILY_CAP_CENTS: '100',
        VOICE_USAGE_PER_SESSION_CAP_CENTS: '500',
      }, () => loadConfig()),
      /VOICE_USAGE_PER_SESSION_CAP_CENTS/,
    );
  });

  it('fails startup for an unknown voice price version when voice is enabled', () => {
    assert.throws(
      () => withEnv({
        WEBAPP_PASSWORD: 'x',
        VOICE_ENABLED: 'true',
        VOICE_USAGE_PRICE_VERSION: 'operator-invented-2099-99',
      }, () => loadConfig()),
      /VOICE_USAGE_PRICE_VERSION/,
    );
  });

  it('rejects a known-version unit-price override below its frozen reference rate', () => {
    const reference = VOICE_PRICE_TABLE[KNOWN_VOICE_PRICE_VERSION].referenceUnitPriceCentsPerMinute;
    assert.throws(
      () => withEnv({
        WEBAPP_PASSWORD: 'x',
        VOICE_ENABLED: 'true',
        VOICE_USAGE_PRICE_VERSION: KNOWN_VOICE_PRICE_VERSION,
        VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE: String(reference - 1),
      }, () => loadConfig()),
      /VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE.*at least/,
      'a reviewed price version must not be configured below its frozen rate',
    );

    const atFloor = withEnv({
      WEBAPP_PASSWORD: 'x',
      VOICE_ENABLED: 'true',
      VOICE_USAGE_PRICE_VERSION: KNOWN_VOICE_PRICE_VERSION,
      VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE: String(reference),
    }, () => loadConfig());
    assert.equal(atFloor.voice.usageUnitPriceCentsPerMinute, reference);

    const conservative = withEnv({
      WEBAPP_PASSWORD: 'x',
      VOICE_ENABLED: 'true',
      VOICE_USAGE_PRICE_VERSION: KNOWN_VOICE_PRICE_VERSION,
      VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE: String(reference + 1),
    }, () => loadConfig());
    assert.equal(conservative.voice.usageUnitPriceCentsPerMinute, reference + 1);
  });

  it('accepts the documented defaults', () => {
    const config = withEnv({ WEBAPP_PASSWORD: 'x' }, () => loadConfig());
    assert.equal(config.serverPort, 3000);
    assert.equal(isKnownVoicePriceVersion(config.voice.usagePriceVersion), true);
    assert.equal(config.trustTailscaleIdentity, false, 'identity trust is opt-in');
  });

  it('validates the stable single-operator budget account id', () => {
    const configured = withEnv({ WEBAPP_PASSWORD: 'x', VOICE_ACCOUNT_ID: 'jon-workstation' }, () => loadConfig());
    assert.equal(configured.voice.accountId, 'jon-workstation');

    const defaulted = withEnv({ WEBAPP_PASSWORD: 'x' }, () => loadConfig());
    assert.ok(defaulted.voice.accountId.length > 0, 'there is always a stable account id');

    for (const bad of ['', '   ', 'has space', 'a'.repeat(200), 'tab\there']) {
      assert.throws(
        () => withEnv({ WEBAPP_PASSWORD: 'x', VOICE_ACCOUNT_ID: bad }, () => loadConfig()),
        /VOICE_ACCOUNT_ID/,
        `"${bad}" is not a usable account id`,
      );
    }
  });
});

describe('context freshness — no unenforced knob is advertised', () => {
  it('does not carry a target max age that nothing enforces', () => {
    const config = withEnv({ WEBAPP_PASSWORD: 'x', VOICE_TARGET_MAX_AGE_MS: '5000' }, () => loadConfig());
    assert.ok(
      !('targetMaxAgeMs' in (config.voice as unknown as Record<string, unknown>)),
      'a freshness bound that is never checked must not be presented as configuration',
    );
  });

  it('does not document the removed knob', () => {
    for (const path of ['.env.example', 'docs/private-voice-pwa-deploy.md', 'docs/dicktator.md']) {
      const text = readFileSync(path, 'utf-8');
      assert.ok(
        !text.includes('VOICE_TARGET_MAX_AGE_MS'),
        `${path} must not advertise a freshness bound the code does not enforce`,
      );
    }
  });
});
