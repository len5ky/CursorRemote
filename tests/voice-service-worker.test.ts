import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { VOICE_HTML, VOICE_JS } from './helpers/voice-client-harness.js';

const VOICE_SW = readFileSync(resolve('src/client/voice-sw.js'), 'utf-8');

/**
 * The voice PWA is one page on a relay that also serves the full remote-control
 * client and every /api route. A worker registered at the default scope would
 * be interposed on all of it, so both halves are exercised for real here: the
 * registration call the page actually makes, and the worker's actual handlers
 * running against dispatched events.
 */

interface RegisterCall {
  url: string;
  options: { scope?: string } | undefined;
}

/** Boot the real voice page and capture what it asks the browser to register. */
function bootstrapWithServiceWorker(options: { secure?: boolean } = {}): RegisterCall[] {
  const dom = new JSDOM(VOICE_HTML, {
    url: 'https://relay.example.ts.net/voice',
    runScripts: 'dangerously',
  });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;

  const calls: RegisterCall[] = [];
  Object.defineProperty(win.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register(url: string, opts?: { scope?: string }) {
        calls.push({ url, options: opts });
        return Promise.resolve({ scope: opts?.scope });
      },
    },
  });
  Object.defineProperty(win, 'isSecureContext', {
    configurable: true,
    value: options.secure ?? true,
  });

  win.eval(VOICE_JS);
  return calls;
}

describe('voice service worker — registration scope', () => {
  it('registers the worker only for the voice surface, not the whole origin', () => {
    const calls = bootstrapWithServiceWorker();

    assert.equal(calls.length, 1, 'the voice page registers exactly one worker');
    assert.equal(calls[0].url, '/voice-sw.js');

    const scope = calls[0].options?.scope;
    assert.ok(
      scope !== undefined,
      'registration must pass an explicit scope; the default scope is the whole origin, '
        + 'which would interpose this worker on /api/* and the main remote-control client',
    );
    assert.ok(
      scope!.startsWith('/voice'),
      `worker scope must be confined to the voice surface, got ${JSON.stringify(scope)}`,
    );
  });

  it('claims a scope that covers the voice page and its assets but no API route', () => {
    const scope = bootstrapWithServiceWorker()[0].options!.scope!;

    // Service worker scope matching is a URL-path prefix test.
    const covered = (path: string): boolean => path.startsWith(scope);

    for (const path of ['/voice', '/voice.html', '/voice.js', '/voice.css', '/voice-sw.js']) {
      assert.equal(covered(path), true, `${path} must stay inside the voice worker scope`);
    }
    for (const path of [
      '/',
      '/index.html',
      '/app.js',
      '/login',
      '/api/voice/token',
      '/api/voice/call',
      '/api/voice/status',
      '/api/voice/heartbeat',
      '/api/voice/terminate',
      '/api/login',
      '/api/state',
      '/socket.io/',
      '/manifest.webmanifest',
    ]) {
      assert.equal(covered(path), false, `${path} must be outside the voice worker scope`);
    }
  });

  it('matches the scope the installed manifest declares', () => {
    const manifest = JSON.parse(readFileSync(resolve('src/client/manifest.webmanifest'), 'utf-8')) as {
      scope: string;
      start_url: string;
    };
    const scope = bootstrapWithServiceWorker()[0].options!.scope!;

    assert.equal(
      scope,
      manifest.scope,
      'a worker scope narrower than the manifest scope leaves part of the installed app uncontrolled, '
        + 'and a wider one controls pages the app does not own',
    );
    assert.equal(manifest.start_url.startsWith(scope), true);
  });

  it('does not register a worker on an insecure origin', () => {
    assert.equal(bootstrapWithServiceWorker({ secure: false }).length, 0);
  });
});

/** Run the real worker source with instrumented globals and no network. */
function loadWorker() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const cacheOperations: string[] = [];
  const networkRequests: string[] = [];
  const waited: unknown[] = [];

  // Any read of the CacheStorage API at all is recorded, so a worker that so
  // much as reaches for `caches` fails this before it can store anything.
  const cachesTrap = new Proxy({}, {
    get(_target, property) {
      cacheOperations.push(String(property));
      return () => {
        cacheOperations.push(`call:${String(property)}`);
        return Promise.reject(new Error('the voice worker must not use CacheStorage'));
      };
    },
  });

  const selfObject = {
    addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
      listeners.set(type, handler);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    caches: cachesTrap,
    registration: { scope: '/voice' },
  };

  const fetchImpl = async (request: { url?: string }) => {
    const url = typeof request === 'string' ? request : (request.url ?? '');
    networkRequests.push(url);
    return { fromNetwork: true, url, bodyUsed: false };
  };

  const context = createContext({
    self: selfObject,
    caches: cachesTrap,
    fetch: fetchImpl,
    console,
    Promise,
  });
  runInContext(VOICE_SW, context);

  return {
    listeners,
    cacheOperations,
    networkRequests,
    waited,
    /** Dispatch a fetch event and return whatever the worker responded with. */
    async dispatchFetch(url: string): Promise<{ fromNetwork?: boolean; url?: string } | undefined> {
      const handler = listeners.get('fetch');
      assert.ok(handler, 'the worker must handle fetch');
      let responded: unknown;
      handler({
        request: { url, method: 'POST' },
        respondWith: (value: unknown) => { responded = value; },
      });
      return (await responded) as { fromNetwork?: boolean; url?: string } | undefined;
    },
    async dispatchLifecycle(type: 'install' | 'activate'): Promise<void> {
      const handler = listeners.get(type);
      assert.ok(handler, `the worker must handle ${type}`);
      handler({ waitUntil: (value: unknown) => { waited.push(value); } });
      await Promise.all(waited);
    },
  };
}

describe('voice service worker — runtime storage behaviour', () => {
  // Every response class the private voice surface must never leave on disk.
  const SENSITIVE = [
    '/api/voice/token',
    '/api/voice/call',
    '/api/voice/status',
    '/api/voice/heartbeat',
    '/api/voice/terminate',
    '/api/voice/disconnect',
    '/api/login',
    '/api/state',
    'https://api.openai.com/v1/realtime/calls',
    'https://api.openai.com/v1/realtime/calls/provider-call-1/hangup',
  ];

  it('serves every sensitive request from the network and stores none of it', async () => {
    const worker = loadWorker();

    for (const url of SENSITIVE) {
      const response = await worker.dispatchFetch(url);
      assert.equal(response?.fromNetwork, true, `${url} must be answered from the network`);
      assert.equal(response?.url, url, `${url} must be passed through untouched`);
    }

    assert.deepEqual(worker.networkRequests, SENSITIVE);
    assert.deepEqual(
      worker.cacheOperations,
      [],
      `the worker touched CacheStorage (${worker.cacheOperations.join(', ')}); `
        + 'auth, session, token, credential, conversation and WebRTC responses must never be stored',
    );
  });

  it('opens no cache while installing or activating', async () => {
    const worker = loadWorker();
    await worker.dispatchLifecycle('install');
    await worker.dispatchLifecycle('activate');

    assert.deepEqual(worker.cacheOperations, [], 'install/activate must not precache anything');
    assert.deepEqual(worker.networkRequests, [], 'install/activate must not prefetch anything');
  });

  it('registers no background sync, push or message handler that could persist data', () => {
    const worker = loadWorker();
    const registered = [...worker.listeners.keys()].sort();

    assert.deepEqual(registered, ['activate', 'fetch', 'install']);
  });
});
