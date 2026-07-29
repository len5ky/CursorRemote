import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAILSCALE_IDENTITY_HEADER,
  isLoopbackAddress,
  resolveLoginIdentity,
} from '../src/server/request-identity.js';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';

/**
 * Behind Tailscale Serve every request arrives from 127.0.0.1, so keying the
 * login limiter on the peer address collapses the whole tailnet into one
 * bucket: one operator's ten fat-fingered attempts lock out everybody else.
 *
 * The fix cannot be "trust a forwarded header", because on a direct request to
 * the loopback port every header is simply whatever the caller typed. The trust
 * boundary is therefore both explicit and narrow:
 *
 *  1. the operator must declare the deployment as Tailscale Serve, and
 *  2. the request must arrive on loopback — which is where, and only where,
 *     the Serve proxy connects from, and Serve strips any client-sent copy of
 *     its identity headers before forwarding.
 *
 * A global abuse guard survives on top, so an attacker who can mint identities
 * still cannot buy unlimited attempts.
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

function failedLogin(harness: VoiceRelayHarness, identity?: string): Promise<{ status: number }> {
  return harness.raw({
    method: 'POST',
    path: '/api/login',
    headers: {
      'Content-Type': 'application/json',
      ...(identity === undefined ? {} : { [TAILSCALE_IDENTITY_HEADER]: identity }),
    },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
}

describe('login identity — verified Tailscale identity, trusted only from the Serve proxy', () => {
  it('gives each verified identity its own bucket when Serve identity is declared', async () => {
    const harness = await track(startVoiceRelay({
      password: 'identity-password',
      trustTailscaleIdentity: true,
    }));

    for (let attempt = 0; attempt < 10; attempt++) {
      await failedLogin(harness, 'alice@example.test');
    }
    const aliceWall = await failedLogin(harness, 'alice@example.test');
    assert.equal(aliceWall.status, 429, 'the noisy identity must hit its own wall');

    const bob = await failedLogin(harness, 'bob@example.test');
    assert.notEqual(bob.status, 429, 'a second verified identity must not inherit the first one\'s bucket');
  });

  it('ignores the identity header entirely when the deployment is not declared as Tailscale Serve', async () => {
    const harness = await track(startVoiceRelay({ password: 'identity-password' }));

    for (let attempt = 0; attempt < 10; attempt++) {
      await failedLogin(harness, `spoofed-${attempt}@example.test`);
    }

    const next = await failedLogin(harness, 'freshly-invented@example.test');
    assert.equal(
      next.status,
      429,
      'without the Serve declaration an arbitrary forwarded header must not mint a fresh bucket',
    );
  });

  it('collapses smuggled duplicate identity headers into one bucket', async () => {
    const harness = await track(startVoiceRelay({
      password: 'identity-password',
      trustTailscaleIdentity: true,
    }));

    // Node joins repeated headers with ", ". A value carrying a separator is
    // not a single verified login, so it must not select a bucket of its own —
    // otherwise appending a comma to a Serve-set header would mint an unlimited
    // supply of them. All of these share the peer bucket and hit its wall.
    let refused = 0;
    for (let attempt = 0; attempt < 15; attempt++) {
      const response = await failedLogin(harness, `carol@example.test, attacker-${attempt}@example.test`);
      if (response.status === 429) refused++;
    }

    assert.ok(
      refused > 0,
      'comma-joined identity headers must not each mint a fresh bucket',
    );
  });

  it('keeps a global abuse guard above the per-identity buckets', async () => {
    const harness = await track(startVoiceRelay({
      password: 'identity-password',
      trustTailscaleIdentity: true,
    }));

    let refused = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      const response = await failedLogin(harness, `minted-${attempt}@example.test`);
      if (response.status === 429) refused++;
    }

    assert.ok(
      refused > 0,
      'minting a fresh identity per attempt must still run into the global login guard',
    );
  });

  it('never reveals the identity in the failure log line', async () => {
    const harness = await track(startVoiceRelay({
      password: 'identity-password',
      trustTailscaleIdentity: true,
    }));

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      await failedLogin(harness, 'secret-operator@example.test');
    } finally {
      console.warn = original;
    }

    assert.ok(warnings.length > 0, 'a failed login is logged');
    for (const line of warnings) {
      assert.ok(
        !line.includes('secret-operator@example.test'),
        `the operator identity must not be written to the log: ${line}`,
      );
    }
  });
});

describe('login identity — resolution rules', () => {
  it('treats only real loopback peers as the Serve proxy', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('100.64.0.5'), false);
    assert.equal(isLoopbackAddress('203.0.113.7'), false);
    assert.equal(isLoopbackAddress(undefined), false);
  });

  it('ignores the identity header from a non-loopback caller even when trust is enabled', () => {
    const spoofed = resolveLoginIdentity({
      remoteAddress: '203.0.113.7',
      headers: { [TAILSCALE_IDENTITY_HEADER]: 'attacker@example.test' },
      trustTailscaleIdentity: true,
    });
    assert.equal(spoofed.source, 'peer-address');
    assert.equal(
      spoofed.key,
      resolveLoginIdentity({ remoteAddress: '203.0.113.7', headers: {}, trustTailscaleIdentity: true }).key,
      'a direct caller cannot choose its own bucket',
    );
  });

  it('ignores the identity header when the deployment has not declared Tailscale Serve', () => {
    const untrusted = resolveLoginIdentity({
      remoteAddress: '127.0.0.1',
      headers: { [TAILSCALE_IDENTITY_HEADER]: 'alice@example.test' },
      trustTailscaleIdentity: false,
    });
    assert.equal(untrusted.source, 'peer-address');
  });

  it('accepts a single well-formed verified identity from loopback under Serve', () => {
    const alice = resolveLoginIdentity({
      remoteAddress: '127.0.0.1',
      headers: { [TAILSCALE_IDENTITY_HEADER]: 'alice@example.test' },
      trustTailscaleIdentity: true,
    });
    const bob = resolveLoginIdentity({
      remoteAddress: '127.0.0.1',
      headers: { [TAILSCALE_IDENTITY_HEADER]: 'bob@example.test' },
      trustTailscaleIdentity: true,
    });
    assert.equal(alice.source, 'tailscale-identity');
    assert.notEqual(alice.key, bob.key);
    assert.ok(!alice.key.includes('alice@example.test'), 'the bucket key must not carry the raw identity');
  });

  it('falls back to the peer address for a malformed or oversized identity', () => {
    const peer = resolveLoginIdentity({ remoteAddress: '127.0.0.1', headers: {}, trustTailscaleIdentity: true });
    for (const hostile of ['', '   ', 'a'.repeat(300), 'alice@example.test\nx: y', 'a,b', 'alice\u0000']) {
      const resolved = resolveLoginIdentity({
        remoteAddress: '127.0.0.1',
        headers: { [TAILSCALE_IDENTITY_HEADER]: hostile },
        trustTailscaleIdentity: true,
      });
      assert.equal(resolved.source, 'peer-address', `"${hostile}" is not a usable verified identity`);
      assert.equal(resolved.key, peer.key);
    }

    const repeated = resolveLoginIdentity({
      remoteAddress: '127.0.0.1',
      headers: { [TAILSCALE_IDENTITY_HEADER]: ['alice@example.test', 'bob@example.test'] },
      trustTailscaleIdentity: true,
    });
    assert.equal(repeated.source, 'peer-address', 'a repeated header is not a single verified identity');
  });
});
