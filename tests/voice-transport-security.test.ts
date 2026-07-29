import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebappSessionStore } from '../src/server/webapp-sessions.js';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';

/**
 * Two ambient-authority leaks around the session token.
 *
 * `origin: true` with `credentials: true` reflects whatever `Origin` the caller
 * sends and tells the browser to send cookies with it, which is the definition
 * of no CORS policy at all. The allow set has to be the same validated
 * canonical origin the voice routes already use.
 *
 * And the persisted session file is a bearer credential store: written 0644 it
 * is readable by every account on the box, so anyone local could lift a live
 * session token straight off disk.
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

const PUBLIC_ORIGIN = 'https://relay.example.ts.net';

describe('socket.io CORS — validated origins only', () => {
  it('does not reflect an arbitrary origin back with credentials', async () => {
    const harness = await track(startVoiceRelay({
      password: 'cors-password',
      publicOrigin: PUBLIC_ORIGIN,
    }));

    const response = await harness.raw({
      path: '/socket.io/?EIO=4&transport=polling',
      headers: { Origin: 'https://evil.example' },
    });

    assert.notEqual(
      response.headers['access-control-allow-origin'],
      'https://evil.example',
      'a foreign origin must never be reflected',
    );
    assert.notEqual(response.headers['access-control-allow-origin'], '*');
  });

  it('allows the configured canonical origin', async () => {
    const harness = await track(startVoiceRelay({
      password: 'cors-password',
      publicOrigin: PUBLIC_ORIGIN,
    }));

    const response = await harness.raw({
      path: '/socket.io/?EIO=4&transport=polling',
      headers: { Origin: PUBLIC_ORIGIN },
    });

    assert.equal(
      response.headers['access-control-allow-origin'],
      PUBLIC_ORIGIN,
      'the canonical public origin is the allow set',
    );
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
  });

  it('refuses a preflight from a foreign origin', async () => {
    const harness = await track(startVoiceRelay({
      password: 'cors-password',
      publicOrigin: PUBLIC_ORIGIN,
    }));

    const response = await harness.raw({
      method: 'OPTIONS',
      path: '/socket.io/?EIO=4&transport=polling',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
      },
    });

    assert.notEqual(response.headers['access-control-allow-origin'], 'https://evil.example');
  });
});

describe('persisted web session store — bearer credentials at 0600', () => {
  it('creates the session file readable only by the owner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-session-store-'));
    try {
      const store = createWebappSessionStore(dir);
      store.add('a'.repeat(64));

      const mode = statSync(join(dir, 'webapp-sessions.json')).mode & 0o777;
      assert.equal(mode.toString(8), '600', 'a session token store must not be world-readable');
      assert.equal(store.has('a'.repeat(64)), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tightens an existing world-readable session file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-session-store-'));
    const file = join(dir, 'webapp-sessions.json');
    try {
      writeFileSync(file, JSON.stringify({ tokens: ['b'.repeat(64)] }) + '\n', 'utf-8');
      chmodSync(file, 0o644);

      const store = createWebappSessionStore(dir);
      store.add('c'.repeat(64));

      assert.equal((statSync(file).mode & 0o777).toString(8), '600');
      assert.equal(store.has('b'.repeat(64)), true, 'existing sessions survive the tightening');
      assert.equal(store.has('c'.repeat(64)), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists a real login at 0600 through the relay', async () => {
    const harness = await track(startVoiceRelay({ password: 'session-store-password' }));
    await harness.login();

    const mode = statSync(join(harness.dataDir, 'webapp-sessions.json')).mode & 0o777;
    assert.equal(mode.toString(8), '600');
  });
});
