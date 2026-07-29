import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertVoicePrivateAuth, loadConfig } from '../src/server/config.js';
import type { ServerConfig } from '../src/server/types.js';
import { testVoiceConfig } from './helpers/voice-fixtures.js';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';

/**
 * The private voice surface is single-operator and read-only, but it still
 * mints paid provider sessions and reads Hermes context. An unauthenticated
 * deployment is not a degraded deployment, it is a hole — so voice must fail
 * closed rather than run open.
 */

function configWith(overrides: { webappPassword: string; voiceEnabled: boolean }): ServerConfig {
  return {
    webappPassword: overrides.webappPassword,
    voice: testVoiceConfig({ enabled: overrides.voiceEnabled }),
  } as unknown as ServerConfig;
}

describe('voice private auth — configuration', () => {
  it('rejects VOICE_ENABLED with an empty or missing WEBAPP_PASSWORD', () => {
    assert.throws(
      () => assertVoicePrivateAuth(configWith({ webappPassword: '', voiceEnabled: true })),
      /WEBAPP_PASSWORD/,
      'an empty password with voice enabled must fail startup',
    );
    assert.throws(
      () => assertVoicePrivateAuth(configWith({ webappPassword: '   ', voiceEnabled: true })),
      /WEBAPP_PASSWORD/,
      'a whitespace-only password must not count as configured',
    );
  });

  it('allows voice with a password, and allows no password when voice is disabled', () => {
    assert.doesNotThrow(() => assertVoicePrivateAuth(configWith({ webappPassword: 'set', voiceEnabled: true })));
    assert.doesNotThrow(() => assertVoicePrivateAuth(configWith({ webappPassword: '', voiceEnabled: false })));
  });

  it('makes loadConfig itself fail closed', () => {
    const saved = { voice: process.env.VOICE_ENABLED, password: process.env.WEBAPP_PASSWORD };
    try {
      process.env.VOICE_ENABLED = 'true';
      delete process.env.WEBAPP_PASSWORD;
      assert.throws(() => loadConfig(), /WEBAPP_PASSWORD/);

      process.env.WEBAPP_PASSWORD = 'a-real-password';
      // Voice also refuses to boot without the server-only Hermes route.
      assert.throws(() => loadConfig(), /VOICE_HERMES_API_URL/);
      process.env.VOICE_HERMES_API_URL = 'https://hermes.private.test';
      process.env.VOICE_HERMES_API_KEY = 'hermes-fixture-key';
      process.env.VOICE_HERMES_SESSION_ID = 'hermes-fixture-session';
      process.env.VOICE_HERMES_SESSION_KEY = 'hermes-fixture-session-key';
      assert.doesNotThrow(() => loadConfig());
    } finally {
      if (saved.voice === undefined) delete process.env.VOICE_ENABLED;
      else process.env.VOICE_ENABLED = saved.voice;
      if (saved.password === undefined) delete process.env.WEBAPP_PASSWORD;
      else process.env.WEBAPP_PASSWORD = saved.password;
      for (const key of ['VOICE_HERMES_API_URL', 'VOICE_HERMES_API_KEY', 'VOICE_HERMES_SESSION_ID', 'VOICE_HERMES_SESSION_KEY']) {
        delete process.env[key];
      }
    }
  });
});

describe('voice private auth — relay fails closed', () => {
  const harnesses: VoiceRelayHarness[] = [];
  after(async () => { for (const h of harnesses) await h.close(); });

  /**
   * The refusal is deliberately opaque to the caller: anything that can reach
   * the port can trigger it, so the missing setting is named to the operator's
   * log and never in the response. The test therefore pins both halves — a bare
   * refusal on the wire, the diagnosis in the log.
   */
  it('refuses every voice route when voice is enabled without a password', async () => {
    const h = await startVoiceRelay({ password: '', voiceEnabled: true });
    harnesses.push(h);

    const serverLog: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => { serverLog.push(args.map(String).join(' ')); };

    try {
      for (const path of ['/api/voice/token', '/api/voice/call', '/api/voice/terminate', '/api/voice/heartbeat']) {
        const response = await fetch(`${h.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        assert.equal(response.status, 503, `${path} must refuse to run unauthenticated`);
        const raw = await response.text();
        const body = JSON.parse(raw) as { error?: string };
        assert.equal(body.error, 'Voice is unavailable.', `${path} must refuse with the generic message only`);
        assert.doesNotMatch(raw, /WEBAPP_PASSWORD/i, `${path} must not name the missing setting to the caller`);
        assert.doesNotMatch(raw, /password/i, `${path} must not hint at the auth mechanism`);
      }

      const status = await fetch(`${h.baseUrl}/api/voice/status`);
      assert.equal(status.status, 503, 'status must not describe a session on an open deployment');
      const statusBody = await status.text();
      assert.equal(
        (JSON.parse(statusBody) as { error?: string }).error,
        'Voice is unavailable.',
        'status must refuse with the same generic message',
      );
      assert.doesNotMatch(statusBody, /WEBAPP_PASSWORD/i, 'status must not name the missing setting to the caller');
    } finally {
      console.error = realConsoleError;
    }

    assert.ok(
      serverLog.some((line) => line.includes('WEBAPP_PASSWORD')),
      'the operator log must name the missing setting even though no response body does',
    );
  });

  it('refuses the voice page and its assets when voice is enabled without a password', async () => {
    const h = await startVoiceRelay({ password: '', voiceEnabled: true });
    harnesses.push(h);

    for (const path of ['/voice', '/voice.html', '/voice.js', '/voice.css']) {
      const response = await fetch(`${h.baseUrl}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 503, `${path} must not be served unauthenticated`);
      assert.doesNotMatch(await response.text(), /createVoiceCallController/, `${path} must not leak the client`);
    }
  });

  it('still serves the voice surface to an authenticated operator when a password is set', async () => {
    const h = await startVoiceRelay({ password: 'harness-password', voiceEnabled: true });
    harnesses.push(h);

    const anonymous = await fetch(`${h.baseUrl}/voice`, { redirect: 'manual' });
    assert.equal(anonymous.status, 302, 'an anonymous visitor is sent to login, not 503');

    const cookie = await h.login();
    const page = await fetch(`${h.baseUrl}/voice`, { headers: { cookie } });
    assert.equal(page.status, 200);

    const token = await fetch(`${h.baseUrl}/api/voice/token`, { method: 'POST', headers: { cookie } });
    assert.equal(token.status, 200);
  });
});
