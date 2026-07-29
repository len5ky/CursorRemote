import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { FixedWindowRateLimiter } from '../src/server/rate-limit.js';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';

/**
 * Rate limiting must key off something the caller cannot choose.
 *
 * `X-Forwarded-For` is attacker-controlled on a direct request to the loopback
 * port, so keying the login limiter off it let one client mint an unlimited
 * number of buckets by rotating the header — the limit was decorative. The
 * limiter table also has to stay bounded, or an attacker who can create keys
 * can grow it without limit.
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

describe('rate limiter — bounded fixed window', () => {
  it('counts within a window and resets after it', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({ limit: 3, windowMs: 100, maxKeys: 16, now: () => now });

    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, true);

    const refused = limiter.check('a');
    assert.equal(refused.allowed, false, 'the fourth attempt in the window is refused');
    assert.ok(refused.retryAfter > 0, 'a refusal reports a positive Retry-After');

    now += 101;
    assert.equal(limiter.check('a').allowed, true, 'the window resets');
  });

  it('keeps separate keys independent', () => {
    const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 16 });
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('b').allowed, true);
    assert.equal(limiter.check('a').allowed, false);
  });

  it('bounds the table so unlimited distinct keys cannot grow it without limit', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 32, now: () => now });

    for (let i = 0; i < 5_000; i++) limiter.check(`key-${i}`);

    assert.ok(
      limiter.size <= 32,
      `the limiter table must stay within maxKeys, saw ${limiter.size}`,
    );
  });

  it('sweeps expired entries rather than only evicting under pressure', () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 100, maxKeys: 1_000, now: () => now });

    for (let i = 0; i < 50; i++) limiter.check(`key-${i}`);
    assert.equal(limiter.size, 50);

    now += 5_000;
    limiter.check('fresh');
    assert.equal(limiter.size, 1, 'expired windows are dropped, not retained');
  });

  it('still refuses a key that keeps hammering inside one window', () => {
    const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 60_000, maxKeys: 4 });
    assert.equal(limiter.check('hot').allowed, true);
    assert.equal(limiter.check('hot').allowed, true);
    for (let i = 0; i < 10; i++) {
      assert.equal(limiter.check('hot').allowed, false, 'a hot key stays refused');
    }
  });
});

describe('login rate limit — forwarded headers are not identity', () => {
  it('cannot be bypassed by rotating X-Forwarded-For', async () => {
    const harness = await track(startVoiceRelay({ password: 'rate-limit-password' }));

    let refused = 0;
    // The login limiter allows 10 per minute. A caller that rotates the
    // forwarded header on every attempt must still hit the wall, because the
    // key comes from the real socket, not the header.
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await harness.raw({
        method: 'POST',
        path: '/api/login',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `203.0.113.${attempt}`,
        },
        body: JSON.stringify({ password: 'wrong-password' }),
      });
      if (response.status === 429) refused++;
    }

    assert.ok(
      refused > 0,
      'rotating X-Forwarded-For must not buy an unlimited number of login attempts',
    );
  });
});

describe('voice rate limit — authenticated identity', () => {
  it('keys the voice limiter to the session, not to a client-supplied address', async () => {
    const harness = await track(startVoiceRelay({ password: 'rate-limit-password' }));
    const cookie = await harness.login();

    let refused = 0;
    // One authenticated identity, many claimed addresses. The bucket is shared.
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await harness.raw({
        method: 'GET',
        path: '/api/voice/status',
        headers: { Cookie: cookie, 'X-Forwarded-For': `198.51.100.${attempt}` },
      });
      if (response.status === 429) refused++;
    }

    assert.ok(
      refused > 0,
      'a single authenticated identity must not escape its limit by varying X-Forwarded-For',
    );
  });

  it('does not let one operator exhaust another operator\'s budget', async () => {
    const harness = await track(startVoiceRelay({ password: 'rate-limit-password' }));
    const noisy = await harness.login();
    const quiet = await harness.login();

    for (let attempt = 0; attempt < 40; attempt++) {
      await harness.raw({ method: 'GET', path: '/api/voice/status', headers: { Cookie: noisy } });
    }

    const response = await harness.raw({
      method: 'GET',
      path: '/api/voice/status',
      headers: { Cookie: quiet },
    });
    assert.notEqual(response.status, 429, 'a second operator has its own budget');
  });
});
