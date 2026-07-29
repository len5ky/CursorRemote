import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startVoiceRelay } from './helpers/voice-relay-harness.js';

/**
 * The Android client's documentation is a compatibility claim about this server.
 *
 * `apps/dicktator-android` was written against the pre-V1 mutation-capable
 * voice surface. V1 removed staged confirmation entirely, so the Approve/Later
 * flow its README documents targets routes that no longer exist. A README that
 * describes a working feature against a server that will 404 it is worse than
 * no README: someone follows it, the car surface fails, and the failure looks
 * like a bug in the relay.
 *
 * This test does not grade prose. It extracts the relay routes the README
 * claims and checks each one against the running server.
 */

const root = join(import.meta.dirname, '..');
const README = join(root, 'apps/dicktator-android/README.md');
const DICKTATOR_DOC = join(root, 'docs/dicktator.md');

/**
 * The paragraph `docs/dicktator.md` devotes to the native Android client.
 * Scoped so these assertions grade that claim and not unrelated prose.
 */
function androidStatusSection(markdown: string): string {
  const start = markdown.search(/^.*\bAndroid client status\b/im);
  assert.notEqual(start, -1, 'docs/dicktator.md must still state the Android client status');
  const rest = markdown.slice(start);
  const end = rest.search(/\n\s*\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every `/api/...` path the README presents as callable. */
function claimedRoutes(markdown: string): string[] {
  const matches = markdown.matchAll(/`?(?:GET|POST|PUT|DELETE)?\s*(\/api\/[A-Za-z0-9/_-]+)`?/g);
  return [...new Set([...matches].map((m) => m[1]))].sort();
}

describe('DICKTATOR Android README — relay compatibility claims', () => {
  it('claims no relay route that this server does not serve', async () => {
    const markdown = readFileSync(README, 'utf8');
    const routes = claimedRoutes(markdown);
    assert.ok(routes.length > 0, 'the README should still document the routes it does use');

    const harness = await startVoiceRelay();
    try {
      const cookie = await harness.login();
      const missing: string[] = [];

      for (const path of routes) {
        const response = await harness.raw({
          method: 'POST',
          path,
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: '{}',
        });
        // An unregistered route falls through every handler to Express's 404.
        // A registered one rejects the empty body instead.
        if (response.status === 404) missing.push(path);
      }

      assert.deepEqual(
        missing,
        [],
        `the Android README documents relay routes this server does not serve: ${missing.join(', ')}`,
      );
    } finally {
      await harness.close();
    }
  });

  it('does not present staged confirmation as an available flow', () => {
    const markdown = readFileSync(README, 'utf8');

    // V1 is read-only: there is no staged mutation, so nothing to approve or
    // defer. Naming these as car-surface actions promises a capability the
    // server deliberately removed.
    assert.doesNotMatch(markdown, /api\/voice\/(confirm|defer)/, 'confirm/defer were removed in V1');
    assert.doesNotMatch(
      markdown,
      /^(?!.*(unsupported|not supported|removed|no longer)).*\b(Approve|Later)\b.*\bcalls\b/im,
      'the README still describes Approve/Later as calling the relay',
    );
  });

  it('states plainly that the native Android client is unsupported in V1', () => {
    const markdown = readFileSync(README, 'utf8');

    assert.match(
      markdown,
      /\bV1\b/,
      'the README must say which server version it is talking about',
    );
    assert.match(
      markdown,
      /unsupported|not supported/i,
      'V1 ships the browser PWA only; the README must say the native client is unsupported',
    );
    assert.match(
      markdown,
      /\/voice\b|PWA|browser/i,
      'the README must point at the surface that is actually supported',
    );
  });
});

describe('docs/dicktator.md — native Android client status', () => {
  it('states plainly that the native Android client is unsupported in V1', () => {
    const section = androidStatusSection(readFileSync(DICKTATOR_DOC, 'utf8'));

    assert.match(
      section,
      /unsupported|not supported/i,
      'docs/dicktator.md must say the native Android client is unsupported on V1, not merely out of date',
    );
    assert.match(
      section,
      /PWA|browser|\/voice\b/i,
      'docs/dicktator.md must point at the surface that is actually supported',
    );
  });

  it('does not claim the Android phone call path still matches', () => {
    const section = androidStatusSection(readFileSync(DICKTATOR_DOC, 'utf8'));

    // "still matches" is a compatibility promise. Nothing in this client is
    // built or tested against V1, so the doc must not assert any part of it works.
    assert.doesNotMatch(
      section,
      /still\s+(matches|works|valid)/i,
      'docs/dicktator.md still claims part of the native Android path matches this server',
    );
  });

  it('does not park retirement of the native client as out of scope', () => {
    const section = androidStatusSection(readFileSync(DICKTATOR_DOC, 'utf8'));

    assert.doesNotMatch(
      section,
      /out of scope/i,
      'the native client is already unshipped for V1; the doc must not defer that as out of scope',
    );
  });
});

describe('private voice V1 supported-surface contract', () => {
  it('serves the browser voice surface that the docs direct users to', async () => {
    const harness = await startVoiceRelay();
    try {
      const cookie = await harness.login();
      const page = await harness.raw({ path: '/voice', headers: { Cookie: cookie } });
      assert.equal(page.status, 200, '/voice is the supported V1 surface');
      assert.match(String(page.headers['content-type']), /text\/html/);
    } finally {
      await harness.close();
    }
  });

  it('serves no staged-confirmation route for any client to call', async () => {
    const harness = await startVoiceRelay();
    try {
      const cookie = await harness.login();
      for (const path of ['/api/voice/confirm', '/api/voice/defer']) {
        const response = await harness.raw({
          method: 'POST',
          path,
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: '{}',
        });
        assert.equal(response.status, 404, `${path} must not exist on a read-only voice surface`);
      }
    } finally {
      await harness.close();
    }
  });
});
