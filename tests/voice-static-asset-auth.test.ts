import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';

/**
 * The private voice page and its script must not be reachable without a
 * session — under *any* spelling of their path.
 *
 * `app.get('/voice.js', guard, …)` matches one exact string. The generic
 * `express.static(clientDir)` mount registered after it does not: `send`
 * decodes the pathname and then `path.normalize`s it, so `//voice.js`,
 * `/./voice.js`, `/voice%2Ejs` and `/a/../voice.js` all resolve to the same
 * file on disk while sailing straight past the router match — the asset came
 * back with no authentication, no CSP, no `Permissions-Policy` and a cacheable
 * `Cache-Control`.
 *
 * Every assertion here is made against a real listening relay over real HTTP.
 * None of it inspects source text.
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

/**
 * Every spelling that resolves to a private voice asset on disk. Each entry is
 * `[requestPath, distinctiveContentFragment]`.
 */
const BYPASS_FORMS: Array<[string, string]> = [
  ['/voice.js', 'createVoiceCallController'],
  ['//voice.js', 'createVoiceCallController'],
  ['/./voice.js', 'createVoiceCallController'],
  ['/a/../voice.js', 'createVoiceCallController'],
  ['/%2Fvoice.js', 'createVoiceCallController'],
  ['/voice%2Ejs', 'createVoiceCallController'],
  ['/%2e/voice.js', 'createVoiceCallController'],
  ['///voice.js', 'createVoiceCallController'],
  ['/voice.css', 'call-button'],
  ['//voice.css', 'call-button'],
  ['/./voice.css', 'call-button'],
  ['/voice%2Ecss', 'call-button'],
  ['/voice.html', 'call-button'],
  ['//voice.html', 'call-button'],
  ['/./voice.html', 'call-button'],
  ['/voice%2Ehtml', 'call-button'],
  ['/voice', 'call-button'],
  ['//voice', 'call-button'],
  ['/./voice', 'call-button'],
];

describe('voice static assets — no path-normalized auth bypass', () => {
  it('refuses every alias of a private voice asset without a session', async () => {
    const harness = await track(startVoiceRelay({ password: 'static-asset-password' }));

    for (const [path, fragment] of BYPASS_FORMS) {
      const response = await harness.raw({ path });
      assert.ok(
        response.status === 302 || response.status === 401 || response.status === 403,
        `${path} must not be served unauthenticated (got HTTP ${response.status})`,
      );
      assert.ok(
        !response.body.includes(fragment),
        `${path} leaked private voice asset content without a session`,
      );
    }
  });

  it('serves every alias with the full voice security headers once authenticated', async () => {
    const harness = await track(startVoiceRelay({ password: 'static-asset-password' }));
    const cookie = await harness.login();

    for (const [path, fragment] of BYPASS_FORMS) {
      const response = await harness.raw({ path, headers: { Cookie: cookie } });
      assert.equal(response.status, 200, `${path} must be served to an authenticated operator`);
      assert.ok(response.body.includes(fragment), `${path} must serve the real voice asset`);

      const csp = response.headers['content-security-policy'];
      assert.ok(
        typeof csp === 'string' && csp.includes("frame-ancestors 'none'"),
        `${path} must carry the voice Content-Security-Policy`,
      );
      assert.match(
        String(response.headers['permissions-policy'] ?? ''),
        /microphone=\(self\)/,
        `${path} must carry the voice Permissions-Policy`,
      );
      assert.equal(
        response.headers['x-content-type-options'],
        'nosniff',
        `${path} must carry X-Content-Type-Options`,
      );
      assert.match(
        String(response.headers['cache-control'] ?? ''),
        /no-store/,
        `${path} must never be cacheable`,
      );
    }
  });

  it('still serves the public installability assets without a session', async () => {
    const harness = await track(startVoiceRelay({ password: 'static-asset-password' }));

    for (const path of ['/manifest.webmanifest', '/voice-sw.js']) {
      const response = await harness.raw({ path });
      assert.equal(response.status, 200, `${path} is deliberately public for installability`);
    }
  });

  it('refuses the voice surface outright when voice is enabled without a password', async () => {
    const harness = await track(startVoiceRelay({ password: '' }));

    for (const path of ['/voice', '//voice.js', '/./voice.css']) {
      const response = await harness.raw({ path });
      assert.equal(response.status, 503, `${path} must refuse rather than serve unauthenticated voice`);
    }
  });
});

describe('voice login redirect — stays inside the installed PWA scope', () => {
  it('sends an unauthenticated voice request to /login with a voice return target', async () => {
    const harness = await track(startVoiceRelay({ password: 'static-asset-password' }));

    for (const path of ['/voice', '/voice.html', '//voice.js']) {
      const response = await harness.raw({ path });
      assert.equal(response.status, 302);
      assert.equal(
        response.headers.location,
        '/login?next=%2Fvoice',
        `${path} must return the operator to the voice page, not the remote-control root`,
      );
    }
  });

  it('honours only an allow-listed same-origin voice return target', async () => {
    const harness = await track(startVoiceRelay({ password: 'static-asset-password' }));

    const inScope = await harness.raw({ path: '/login?next=%2Fvoice' });
    assert.equal(inScope.status, 200);
    assert.ok(
      inScope.body.includes('window.location.href = "/voice";'),
      'an in-scope target is used verbatim',
    );

    for (const hostile of [
      'https://evil.example/x',
      '//evil.example/x',
      '/api/login',
      '/voice/../admin',
      'javascript:alert(1)',
      '/voice";document.cookie//',
    ]) {
      const response = await harness.raw({ path: `/login?next=${encodeURIComponent(hostile)}` });
      assert.equal(response.status, 200);
      assert.ok(
        response.body.includes('window.location.href = "/";'),
        `${hostile} must fall back to the root`,
      );
      assert.ok(
        !response.body.includes(`window.location.href = "${hostile}"`),
        `${hostile} must never become the redirect target`,
      );
    }
  });
});
