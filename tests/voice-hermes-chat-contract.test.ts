import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  HERMES_CHAT_PATH_TEMPLATE,
  HERMES_CAPABILITIES_PATH,
  HERMES_TOOLSETS_PATH,
  HERMES_SESSION_KEY_HEADER,
  HermesSessionChatClient,
  VOICE_HERMES_MAX_ASSISTANT_BYTES,
  VOICE_HERMES_MAX_SESSION_ID_BYTES,
  VOICE_HERMES_MAX_TRANSCRIPT_BYTES,
  assertVoiceHermesRoute,
  buildHermesChatRequest,
  evaluateHermesToolPolicy,
  hermesChatUrl,
  normalizeVoiceTranscript,
  resolveVoiceHermesRoute,
} from '../src/server/transports/voice/hermes-chat.js';
import { hermesCapabilities, hermesToolsets, testVoiceConfig } from './helpers/voice-fixtures.js';

/**
 * The Hermes session-chat route is the ONLY conversational authority on this
 * surface. The Realtime model is ears and mouth; every word it speaks comes
 * back from here.
 *
 * Everything below runs against injected fetch doubles. No test in this file
 * opens a socket to a real Hermes deployment or to any provider.
 */

const root = join(import.meta.dirname, '..');
const ROUTE = testVoiceConfig().hermes;

function recordingFetch(handler: (url: string, init: RequestInit) => Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('hermes session-chat request contract', () => {
  it('builds exactly the supported POST /api/sessions/{session_id}/chat request', () => {
    const request = buildHermesChatRequest(ROUTE, ROUTE.sessionId, 'where are we up to');

    assert.equal(request.url, 'https://hermes.private.test/api/sessions/hermes-session-configured/chat');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.Authorization, `Bearer ${ROUTE.apiKey}`);
    assert.equal(request.headers[HERMES_SESSION_KEY_HEADER], ROUTE.sessionKey);
    assert.equal(request.headers['Content-Type'], 'application/json');

    // The actual transcript travels in the documented message field — not a
    // summary, not a placeholder, not the provider call id.
    const body = JSON.parse(request.body) as Record<string, unknown>;
    assert.equal(body.message, 'where are we up to');
  });

  it('percent-encodes the session id into the documented path', () => {
    assert.equal(
      hermesChatUrl({ ...ROUTE, apiUrl: 'https://hermes.private.test/' }, 'a b/c'),
      'https://hermes.private.test/api/sessions/a%20b%2Fc/chat',
    );
  });

  it('sends the configured stable session mapping and never a caller-supplied one', async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ content: 'all done' }));
    const client = new HermesSessionChatClient(ROUTE, { fetchImpl });

    const result = await client.send('status please', { signal: new AbortController().signal });

    assert.deepEqual(result, { kind: 'ok', assistantText: 'all done' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://hermes.private.test/api/sessions/${ROUTE.sessionId}/chat`);
    assert.equal(JSON.parse(String(calls[0].init.body)).message, 'status please');

    // There is no parameter, option or payload field through which a caller —
    // browser or otherwise — can name a different Hermes session or key.
    const surface = [
      ...Object.getOwnPropertyNames(HermesSessionChatClient.prototype),
      ...Object.keys(client as unknown as Record<string, unknown>),
    ];
    for (const name of surface) {
      assert.doesNotMatch(
        name,
        /^(setSession|useSession|withSession|selectSession|setKey|setRoute)/i,
        `HermesSessionChatClient.${name} would let a caller choose Hermes identity`,
      );
    }
    assert.equal(client.sessionId, ROUTE.sessionId, 'the mapping is server state, not request input');
  });

  it('adopts an effective/rotated session id returned by the server for later turns', async () => {
    let turn = 0;
    const { fetchImpl, calls } = recordingFetch(() => {
      turn += 1;
      return jsonResponse(turn === 1
        ? { content: 'first', session_id: 'hermes-session-rotated' }
        : { content: 'second' });
    });
    const client = new HermesSessionChatClient(ROUTE, { fetchImpl });

    await client.send('one', { signal: new AbortController().signal });
    await client.send('two', { signal: new AbortController().signal });

    assert.equal(calls[0].url.includes(ROUTE.sessionId), true, 'the first turn uses the configured mapping');
    assert.equal(calls[1].url.includes('hermes-session-rotated'), true, 'later turns follow the effective id');
    assert.equal(client.sessionId, 'hermes-session-rotated');
  });

  it('never lets credentials or raw upstream detail escape the returned result', async () => {
    const { fetchImpl } = recordingFetch(() => new Response(
      `internal hermes stack trace: bearer ${ROUTE.apiKey} at /srv/hermes/app.py:44`,
      { status: 500 },
    ));
    const client = new HermesSessionChatClient(ROUTE, { fetchImpl });

    const result = await client.send('hello', { signal: new AbortController().signal });

    assert.equal(result.kind, 'error');
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(ROUTE.apiKey));
    assert.doesNotMatch(serialized, new RegExp(ROUTE.sessionKey));
    assert.doesNotMatch(serialized, /stack trace|app\.py/);
  });

  it('bounds and validates the assistant content it will accept', async () => {
    const cases: Array<{ body: unknown; label: string }> = [
      { body: { content: '' }, label: 'empty content' },
      { body: { content: '   ' }, label: 'whitespace-only content' },
      { body: { content: 42 }, label: 'non-string content' },
      { body: { nope: 'x' }, label: 'missing content' },
      { body: ['content'], label: 'array body' },
      { body: { content: 'あ'.repeat(VOICE_HERMES_MAX_ASSISTANT_BYTES) }, label: 'over the byte bound' },
      { body: { content: 'ok', session_id: 'x'.repeat(VOICE_HERMES_MAX_SESSION_ID_BYTES + 1) }, label: 'over-long session id' },
      { body: { content: 'ok', session_id: 42 }, label: 'non-string session id' },
    ];

    for (const { body, label } of cases) {
      const { fetchImpl } = recordingFetch(() => jsonResponse(body));
      const client = new HermesSessionChatClient(ROUTE, { fetchImpl });
      const result = await client.send('hi', { signal: new AbortController().signal });
      assert.equal(result.kind, 'error', `${label} must be refused, not spoken`);
    }

    // The documented nested shape is accepted.
    const { fetchImpl } = recordingFetch(() => jsonResponse({ message: { content: 'nested answer' } }));
    const client = new HermesSessionChatClient(ROUTE, { fetchImpl });
    assert.deepEqual(
      await client.send('hi', { signal: new AbortController().signal }),
      { kind: 'ok', assistantText: 'nested answer' },
    );
  });

  it('carries the caller abort signal and a request timeout', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const { fetchImpl } = recordingFetch((_url, init) => {
      seenSignal = init.signal as AbortSignal;
      return jsonResponse({ content: 'late' });
    });
    const client = new HermesSessionChatClient(ROUTE, { fetchImpl, timeoutMs: 1_000 });

    await client.send('hi', { signal: controller.signal });
    assert.ok(seenSignal, 'the upstream request must carry an abort signal');

    controller.abort();
    assert.equal(seenSignal!.aborted, true, 'aborting the turn must abort the relay fetch');
  });

  it('reports an aborted turn as an error rather than fabricating speech', async () => {
    const controller = new AbortController();
    const { fetchImpl } = recordingFetch(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
    const client = new HermesSessionChatClient(ROUTE, { fetchImpl });
    controller.abort();

    const result = await client.send('hi', { signal: controller.signal });
    assert.equal(result.kind, 'error');
    assert.equal('assistantText' in result, false);
  });
});

describe('voice transcript validation before Hermes ever sees it', () => {
  it('accepts a real transcript and normalizes surrounding whitespace only', () => {
    const ok = normalizeVoiceTranscript('  where are we up to  ');
    assert.deepEqual(ok, { ok: true, text: 'where are we up to' });
  });

  it('rejects empty, non-string and over-bound transcripts instead of truncating them', () => {
    for (const bad of ['', '   ', '\n\t', undefined, null, 42, {}, ['hi']]) {
      assert.equal(normalizeVoiceTranscript(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
    }
    // Measured in UTF-8 bytes, not UTF-16 code units.
    const overBound = 'あ'.repeat(VOICE_HERMES_MAX_TRANSCRIPT_BYTES);
    assert.equal(Buffer.byteLength(overBound, 'utf8') > VOICE_HERMES_MAX_TRANSCRIPT_BYTES, true);
    assert.equal(normalizeVoiceTranscript(overBound).ok, false, 'an over-bound transcript is refused, never trimmed');

    const atBound = 'a'.repeat(VOICE_HERMES_MAX_TRANSCRIPT_BYTES);
    assert.deepEqual(normalizeVoiceTranscript(atBound), { ok: true, text: atBound });
  });
});

describe('hermes route configuration fails closed', () => {
  it('resolves a complete server-only route', () => {
    const resolved = resolveVoiceHermesRoute(ROUTE);
    assert.equal(resolved.ok, true);
  });

  it('refuses a missing, partial or non-HTTPS route', () => {
    const bad: Array<[typeof ROUTE, string]> = [
      [{ ...ROUTE, apiUrl: '' }, 'missing api url'],
      [{ ...ROUTE, apiKey: '' }, 'missing api key'],
      [{ ...ROUTE, sessionId: '' }, 'missing session id'],
      [{ ...ROUTE, sessionKey: '' }, 'missing session key'],
      [{ ...ROUTE, capabilitiesPath: '/api/capabilities' }, 'invented capabilities endpoint'],
      [{ ...ROUTE, toolsetsPath: '/api/toolsets' }, 'undocumented toolsets endpoint'],
      [{ ...ROUTE, apiUrl: 'http://hermes.public.test' }, 'plaintext non-loopback url'],
      [{ ...ROUTE, apiUrl: 'not a url' }, 'unparseable url'],
    ];
    for (const [route, label] of bad) {
      const resolved = resolveVoiceHermesRoute(route as never);
      assert.equal(resolved.ok, false, `${label} must fail closed`);
      assert.throws(() => assertVoiceHermesRoute(route as never), /HERMES_/);
    }
    // Loopback HTTP stays usable for a same-host private deployment.
    assert.equal(resolveVoiceHermesRoute({ ...ROUTE, apiUrl: 'http://127.0.0.1:8080' }).ok, true);
  });

  it('never puts route secrets into the failure message', () => {
    try {
      assertVoiceHermesRoute({ ...ROUTE, sessionId: '' } as never);
      assert.fail('expected a startup failure');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.doesNotMatch(message, new RegExp(ROUTE.apiKey));
      assert.doesNotMatch(message, new RegExp(ROUTE.sessionKey));
    }
  });
});

describe('hermes deployment tool policy — a prompt is not enforcement', () => {
  it('accepts documented capabilities with exactly zero effective toolsets', () => {
    assert.equal(evaluateHermesToolPolicy(hermesCapabilities(), hermesToolsets()).ok, true);
    assert.equal(
      evaluateHermesToolPolicy(
        hermesCapabilities(),
        hermesToolsets({ data: [{ name: 'read_only', label: 'Read only', description: '', enabled: false, configured: false, tools: [] }] }),
      ).ok,
      true,
      'disabled rows in the discovery listing are not effective toolsets',
    );
  });

  it('fails closed on every way the deployment could still run tools', () => {
    const rejected: Array<[unknown, unknown, string]> = [
      [hermesCapabilities({ platform: 'shared' }), hermesToolsets(), 'non-Hermes deployment'],
      [hermesCapabilities({ mcp: { enabled: true } }), hermesToolsets(), 'MCP enabled'],
      [hermesCapabilities({ endpoints: {} }), hermesToolsets(), 'undocumented toolsets endpoint'],
      [hermesCapabilities(), hermesToolsets({ data: [{ name: 'read_only', enabled: true, tools: [] }] }), 'an effective toolset'],
      [hermesCapabilities(), hermesToolsets({ data: [{ name: 'mcp-filesystem', enabled: true, tools: ['read_file'] }] }), 'an effective MCP toolset'],
      [hermesCapabilities(), hermesToolsets({ data: [{ name: 'read_only', enabled: 'false', tools: [] }] }), 'a malformed enabled flag'],
      [hermesCapabilities(), hermesToolsets({ data: [{ name: 'read_only', enabled: false, tools: [1] }] }), 'a malformed tool list'],
      [hermesCapabilities(), { object: 'list', platform: 'api_server' }, 'undeclared toolset data'],
      [null, hermesToolsets(), 'no capabilities at all'],
      ['read only please', hermesToolsets(), 'a prose claim instead of a capability report'],
    ];
    for (const [capabilities, toolsets, label] of rejected) {
      assert.equal(evaluateHermesToolPolicy(capabilities, toolsets).ok, false, `${label} must fail closed`);
    }
  });

  it('rejects /api/capabilities and validates the documented /v1 endpoints', async () => {
    assert.equal(HERMES_CAPABILITIES_PATH, '/v1/capabilities');
    assert.equal(HERMES_TOOLSETS_PATH, '/v1/toolsets');
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.endsWith(HERMES_CAPABILITIES_PATH)) return jsonResponse(hermesCapabilities());
      if (url.endsWith(HERMES_TOOLSETS_PATH)) return jsonResponse(hermesToolsets());
      throw new Error(`unexpected Hermes policy endpoint: ${url}`);
    });
    const client = new HermesSessionChatClient(ROUTE, { fetchImpl });
    assert.deepEqual(await client.verifyPolicy(), { ok: true });
    assert.deepEqual(calls.map((call) => call.url), [
      `${ROUTE.apiUrl}${HERMES_CAPABILITIES_PATH}`,
      `${ROUTE.apiUrl}${HERMES_TOOLSETS_PATH}`,
    ]);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(
      (calls[0].init.headers as Record<string, string>).Authorization,
      `Bearer ${ROUTE.apiKey}`,
    );
  });

  it('refuses unreachable, malformed or permissive capabilities/toolsets', async () => {
    for (const responder of [
      (url: string) => url.endsWith(HERMES_CAPABILITIES_PATH)
        ? jsonResponse(hermesCapabilities({ mcp: { enabled: true } }))
        : jsonResponse(hermesToolsets()),
      (url: string) => url.endsWith(HERMES_CAPABILITIES_PATH)
        ? jsonResponse({ nope: true })
        : jsonResponse(hermesToolsets()),
      (url: string) => url.endsWith(HERMES_CAPABILITIES_PATH)
        ? jsonResponse(hermesCapabilities())
        : new Response('nope', { status: 500 }),
      (_url: string) => { throw new Error('connection refused'); },
    ]) {
      const { fetchImpl } = recordingFetch((url) => responder(url));
      const client = new HermesSessionChatClient(ROUTE, { fetchImpl });
      const verdict = await client.verifyPolicy();
      assert.equal(verdict.ok, false);
      assert.doesNotMatch(JSON.stringify(verdict), new RegExp(ROUTE.apiKey));
    }
  });
});

describe('no Hermes identity reaches the browser', () => {
  it('keeps every Hermes route name and value out of the shipped client assets', () => {
    const clientDir = join(root, 'src/client');
    for (const file of readdirSync(clientDir)) {
      if (!/\.(js|html|css|webmanifest)$/.test(file)) continue;
      const source = readFileSync(join(clientDir, file), 'utf8');
      assert.doesNotMatch(source, /VOICE_HERMES_API_KEY|VOICE_HERMES_SESSION_KEY|VOICE_HERMES_SESSION_ID|VOICE_HERMES_API_URL/, `${file} names a server-only Hermes value`);
      assert.doesNotMatch(source, /x-hermes-session-key/i, `${file} builds a Hermes session header`);
      assert.doesNotMatch(source, /api\/sessions\/[^/]*\/chat/, `${file} calls Hermes session chat directly`);
      assert.doesNotMatch(source, /hermesSessionId|hermesSessionKey|hermesApiKey/i, `${file} carries Hermes identity`);
    }
  });

  it('exposes no browser-facing relay route that accepts a Hermes session or key', () => {
    const relay = readFileSync(join(root, 'src/server/relay.ts'), 'utf8');
    assert.doesNotMatch(relay, /hermesSessionId|hermesSessionKey|hermesApiKey|X-Hermes-Session-Key/i);
    assert.doesNotMatch(relay, /api\/voice\/(hermes|chat|session-key)/);
  });
});

describe('hermes route ownership — the contract lives in one module', () => {
  const VOICE_DIR = join(root, 'src/server/transports/voice');

  /**
   * Where the Hermes route literal is allowed to exist is itself a contract.
   *
   * A reader looking for proof that this relay calls Hermes session chat will
   * be tempted to grep the Realtime bridge for `/api/sessions/…/chat`, and will
   * not find it — correctly. The bridge owns turn semantics and speaks to a
   * narrow `send(transcript, { signal })` collaborator; it has no business
   * knowing Hermes' HTTP shape, and a second place that composed that URL would
   * be a second place that could get the headers, the session mapping or the
   * message field wrong.
   *
   * The evidence lives where the behaviour does: `hermes-chat.ts` exports the
   * path template and the request builder, `buildHermesChatRequest` is asserted
   * above, and the mocked lifecycle smoke asserts the exact URL actually called
   * through a real client. These assertions pin that arrangement in place.
   */

  it('keeps the session-chat path in hermes-chat.ts and nowhere else', () => {
    const owners = readdirSync(VOICE_DIR).filter((file) => {
      if (!file.endsWith('.ts')) return false;
      return /api\/sessions/.test(readFileSync(join(VOICE_DIR, file), 'utf8'));
    });
    assert.deepEqual(owners, ['hermes-chat.ts'], 'exactly one module may compose the Hermes route');

    // And it is composed from the exported template, not hand-written twice.
    assert.equal(HERMES_CHAT_PATH_TEMPLATE, '/api/sessions/{session_id}/chat');
    assert.equal(
      hermesChatUrl(ROUTE, 's'),
      `${ROUTE.apiUrl}${HERMES_CHAT_PATH_TEMPLATE.replace('{session_id}', 's')}`,
    );
  });

  it('makes the bridge depend on the narrow collaborator, not on the HTTP client', () => {
    const bridge = readFileSync(join(VOICE_DIR, 'realtime-bridge.ts'), 'utf8');

    // The dependency is real and visible in production source...
    assert.match(bridge, /from '\.\/hermes-chat\.js'/, 'the bridge must import its Hermes contract');
    assert.match(bridge, /VoiceHermesSpeechSource/, 'and depend on the send-only collaborator');
    assert.match(bridge, /normalizeVoiceTranscript/, 'and validate transcripts with the shared helper');
    assert.match(bridge, /input_audio_transcription\.completed/, 'triggered by the final transcript');
    assert.match(bridge, /this\.hermes\.send\(/, 'which is what actually reaches Hermes');

    // ...and it stops there. No URL, no credential, no client construction.
    assert.doesNotMatch(bridge, /HermesSessionChatClient/, 'the bridge must not construct the HTTP client');
    assert.doesNotMatch(bridge, /VOICE_HERMES_API|Authorization: `Bearer \$\{[^}]*hermes/i);
    assert.doesNotMatch(bridge, /X-Hermes-Session-Key/i, 'the bridge never builds Hermes headers');
  });

  it('composes the whole route from the server-held config, in the composition root', () => {
    // Startup is the only place a route becomes a client: config -> validated
    // route -> client -> transport. Nothing downstream can substitute another.
    const main = readFileSync(join(root, 'src/server/index.ts'), 'utf8');
    assert.match(main, /assertVoiceHermesRoute\(config\.voice\.hermes\)/);
    assert.match(main, /new HermesSessionChatClient\(route\)/);
    assert.match(main, /new VoiceTransport\(/);
  });
});
