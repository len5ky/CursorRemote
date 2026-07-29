import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceOriginPolicy,
  normalizeVoiceOrigin,
} from '../src/server/transports/voice/origin-policy.js';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';

/**
 * Tailscale Serve terminates TLS and forwards to loopback HTTP, so the request
 * the relay sees is http:// while the browser's Origin is https://. Deriving
 * the expected origin from req.protocol/Host (or from any X-Forwarded-*
 * header) is therefore both broken for the real deployment and forgeable by a
 * hostile caller. The canonical public origin must be explicit configuration.
 */

const TAILSCALE_ORIGIN = 'https://relay.example.ts.net';

describe('voice origin policy — configuration validation', () => {
  it('accepts a bare HTTPS origin and normalizes it', () => {
    assert.equal(normalizeVoiceOrigin('https://relay.example.ts.net'), 'https://relay.example.ts.net');
    assert.equal(normalizeVoiceOrigin('https://relay.example.ts.net/'), 'https://relay.example.ts.net');
    assert.equal(normalizeVoiceOrigin('https://relay.example.ts.net:8443'), 'https://relay.example.ts.net:8443');
  });

  it('accepts loopback HTTP for local development only', () => {
    assert.equal(normalizeVoiceOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
    assert.equal(normalizeVoiceOrigin('http://localhost:3000'), 'http://localhost:3000');
    assert.throws(() => normalizeVoiceOrigin('http://relay.example.ts.net'), /https/i,
      'plain HTTP on a routable host is not a secure context and must be refused');
  });

  it('refuses anything that is not a bare origin', () => {
    for (const bad of [
      'relay.example.ts.net',
      'https://relay.example.ts.net/voice',
      'https://relay.example.ts.net?x=1',
      'https://relay.example.ts.net#frag',
      'https://user:pw@relay.example.ts.net',
      'wss://relay.example.ts.net',
      'javascript:alert(1)',
      'null',
      '*',
    ]) {
      assert.throws(() => normalizeVoiceOrigin(bad), Error, `${bad} must be refused`);
    }
  });
});

describe('voice origin policy — allow set', () => {
  it('permits the configured public origin and loopback, and nothing else', () => {
    const policy = createVoiceOriginPolicy({ publicOrigin: TAILSCALE_ORIGIN, serverPort: 3000 });

    assert.equal(policy.allows(TAILSCALE_ORIGIN), true);
    assert.equal(policy.allows('http://127.0.0.1:3000'), true);
    assert.equal(policy.allows('http://localhost:3000'), true);

    assert.equal(policy.allows('https://evil.example.com'), false);
    assert.equal(policy.allows('http://relay.example.ts.net'), false, 'the http twin of the public origin is not the public origin');
    assert.equal(policy.allows('https://relay.example.ts.net.evil.com'), false);
    assert.equal(policy.allows('https://relay.example.ts.net:8443'), false, 'a different port is a different origin');
    assert.equal(policy.allows('null'), false);
    assert.equal(policy.allows(['https://relay.example.ts.net', 'https://evil.example.com']), false,
      'a duplicated Origin header must never be accepted');
  });

  it('treats an absent Origin as same-origin/non-browser and allows it', () => {
    const policy = createVoiceOriginPolicy({ publicOrigin: TAILSCALE_ORIGIN, serverPort: 3000 });
    assert.equal(policy.allows(undefined), true);
  });

  it('falls back to loopback only when no public origin is configured', () => {
    const policy = createVoiceOriginPolicy({ publicOrigin: '', serverPort: 3000 });
    assert.equal(policy.allows('http://127.0.0.1:3000'), true);
    assert.equal(policy.allows(TAILSCALE_ORIGIN), false, 'an unconfigured deployment must fail closed for remote origins');
  });
});

describe('voice origin policy — relay routes', () => {
  const harnesses: VoiceRelayHarness[] = [];
  after(async () => { for (const h of harnesses) await h.close(); });

  async function harness(): Promise<{ h: VoiceRelayHarness; cookie: string }> {
    const h = await startVoiceRelay({ publicOrigin: TAILSCALE_ORIGIN });
    harnesses.push(h);
    return { h, cookie: await h.login() };
  }

  it('permits the documented Tailscale Serve HTTPS origin over forwarded plain HTTP', async () => {
    const { h, cookie } = await harness();
    const response = await fetch(`${h.baseUrl}/api/voice/status`, {
      headers: { cookie, origin: TAILSCALE_ORIGIN },
    });
    assert.equal(response.status, 200, 'the real deployment origin must be accepted');
  });

  it('rejects a hostile Origin', async () => {
    const { h, cookie } = await harness();
    const response = await fetch(`${h.baseUrl}/api/voice/status`, {
      headers: { cookie, origin: 'https://evil.example.com' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { error: string }).error, 'Origin denied');
  });

  it('ignores X-Forwarded-* headers when deciding the origin', async () => {
    const { h, cookie } = await harness();
    const spoofed = await fetch(`${h.baseUrl}/api/voice/status`, {
      headers: {
        cookie,
        origin: 'https://evil.example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'evil.example.com',
        'x-forwarded-for': '100.64.0.1',
      },
    });
    assert.equal(spoofed.status, 403, 'a forwarded header must never widen the allow set');

    // And the reverse: forwarded headers claiming a hostile origin cannot
    // narrow or override the genuine, allowed Origin either.
    const genuine = await fetch(`${h.baseUrl}/api/voice/status`, {
      headers: { cookie, origin: TAILSCALE_ORIGIN, 'x-forwarded-host': 'evil.example.com' },
    });
    assert.equal(genuine.status, 200);
  });

  it('rejects a spoofed Host header matching a hostile Origin', async () => {
    const { h, cookie } = await harness();
    const response = await h.raw({
      path: '/api/voice/status',
      headers: { Host: 'evil.example.com', Origin: 'https://evil.example.com', Cookie: cookie },
    });
    assert.equal(response.status, 403, 'the expected origin must not be derived from the Host header');
  });

  it('rejects a hostile Origin on state-changing voice routes too', async () => {
    const { h, cookie } = await harness();
    for (const path of ['/api/voice/token', '/api/voice/call', '/api/voice/terminate', '/api/voice/heartbeat']) {
      const response = await fetch(`${h.baseUrl}${path}`, {
        method: 'POST',
        headers: { cookie, origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 403, `${path} must refuse a hostile origin`);
    }
  });
});
