import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type WebSocket from 'ws';
import {
  RealtimeBridge,
  buildSessionConfig,
  extractCallId,
  safetyIdentifierForAccount,
  type RealtimeBridgeOptions,
} from '../src/server/transports/voice/realtime-bridge.js';
import { VOICE_REALTIME_MODEL, VOICE_TRANSCRIPTION_MODEL } from '../src/server/transports/voice/constants.js';
import { assertPinnedVoiceModel } from '../src/server/config.js';
import type { VoiceSessionContext } from '../src/server/transports/voice/session.js';
import { FakeHermesAgent, FakeRealtimeSocket, testVoiceConfig } from './helpers/voice-fixtures.js';

const root = join(import.meta.dirname, '..');
const authority = {
  accepts: () => true,
  userTurn: () => {},
  providerFailure: () => {},
  reportSpend: () => false,
};

describe('private voice provider contract', () => {
  it('mints a browser-only secret with a stable hashed safety identifier', async () => {
    let request: RequestInit | undefined;
    const bridge = new RealtimeBridge(testVoiceConfig(), new FakeHermesAgent(), authority, {
      fetchImpl: (async (_input, init) => {
        request = init;
        return new Response(JSON.stringify({ value: 'ephemeral-browser-secret', expires_at: 123, model: 'gpt-realtime-2.1' }), { status: 200 });
      }) as typeof fetch,
    });

    const result = await bridge.mintClientSecret('authenticated-account-a');

    // The browser receives the ephemeral credential under an unambiguous name.
    assert.equal(result.clientSecret, 'ephemeral-browser-secret');
    assert.equal((request?.headers as Record<string, string>).Authorization, 'Bearer server-key-for-test');

    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    assert.match(String(body.safety_identifier), /^[a-f0-9]{64}$/, 'safety_identifier must be a SHA-256 digest');
    assert.notEqual(body.safety_identifier, 'authenticated-account-a', 'the raw account key must not leave the relay');

    // The standard key must never appear in anything handed back to the browser.
    assert.doesNotMatch(JSON.stringify(result), /server-key-for-test/);
  });

  it('derives a stable but non-reversible safety identifier per account', () => {
    const a1 = safetyIdentifierForAccount('account-a');
    const a2 = safetyIdentifierForAccount('account-a');
    const b1 = safetyIdentifierForAccount('account-b');
    assert.equal(a1, a2, 'the same account must hash stably across calls');
    assert.notEqual(a1, b1, 'different accounts must not collide');
    assert.doesNotMatch(a1, /account-a/);
  });

  it('attaches sideband with only the server key and extracts the provider call id', async () => {
    const socket = new FakeRealtimeSocket();
    let openedUrl = '';
    let openedHeaders: Record<string, string> = {};
    const options: RealtimeBridgeOptions = {
      websocketFactory: (url, wsOptions) => {
        openedUrl = url;
        openedHeaders = wsOptions.headers as Record<string, string>;
        return socket as unknown as WebSocket;
      },
    };
    const bridge = new RealtimeBridge(testVoiceConfig(), new FakeHermesAgent(), authority, options);
    const context: VoiceSessionContext = { sessionId: 's', epoch: 1, leaseId: 'l' };

    await bridge.attachSideband('provider-call-123', context);

    assert.equal(openedUrl, 'wss://api.openai.com/v1/realtime?call_id=provider-call-123');
    assert.equal(openedHeaders.Authorization, 'Bearer server-key-for-test');
    assert.notEqual(openedHeaders.Authorization, 'ephemeral-browser-secret');
    assert.equal(extractCallId(new Headers({ location: 'https://api.openai.com/v1/realtime/calls/provider-call-123' })), 'provider-call-123');
    assert.equal(extractCallId(new Headers()), null);

    // The provider is offered no tools at all: it is ears and mouth, and the
    // only conversational authority is the private Hermes deployment reached
    // server-to-server.
    const session = buildSessionConfig(testVoiceConfig()).session as { tools?: unknown[]; tool_choice?: string };
    assert.deepEqual(session.tools, []);
    assert.equal(session.tool_choice, 'none');
  });
});

describe('private voice exact model invariant', () => {
  it('pins every provider session to gpt-realtime-2.1', () => {
    assert.equal(VOICE_REALTIME_MODEL, 'gpt-realtime-2.1');
    const session = buildSessionConfig(testVoiceConfig()).session as { model?: string };
    assert.equal(session.model, 'gpt-realtime-2.1');
  });

  it('offers no configurable model to override and no fallback', () => {
    // VoiceConfig carries no model field at all, so there is nothing to point
    // at a mini, preview or fallback model.
    assert.equal('model' in testVoiceConfig(), false);
    assert.equal('miniModel' in testVoiceConfig(), false);

    // Every model identifier anywhere in the voice subsystem must be the pin.
    for (const file of readdirSync(join(root, 'src/server/transports/voice'))) {
      const source = readFileSync(join(root, 'src/server/transports/voice', file), 'utf8');
      const modelLiterals = source.match(/gpt-[A-Za-z0-9._-]+/g) ?? [];
      for (const literal of modelLiterals) {
        assert.equal(literal, VOICE_REALTIME_MODEL, `${file} references a non-pinned model: ${literal}`);
      }
    }
  });

  it('pins the transcription model separately and never uses it to answer', () => {
    // Input transcription needs an ASR model, and it is not the Realtime model.
    // It is pinned in exactly one place, it is not a `gpt-*` conversational
    // model, and it appears only in the transcription block of the session
    // config — there is no path by which it could produce assistant content.
    assert.equal(VOICE_TRANSCRIPTION_MODEL, 'whisper-1');
    assert.notEqual(VOICE_TRANSCRIPTION_MODEL, VOICE_REALTIME_MODEL);

    const session = buildSessionConfig(testVoiceConfig()).session as {
      audio: { input: { transcription: { model: string } } };
    };
    assert.equal(session.audio.input.transcription.model, VOICE_TRANSCRIPTION_MODEL);

    const bridge = readFileSync(join(root, 'src/server/transports/voice/realtime-bridge.ts'), 'utf8');
    assert.equal(
      (bridge.match(/VOICE_TRANSCRIPTION_MODEL/g) ?? []).length,
      2,
      'the ASR pin is imported once and used once, in the transcription config',
    );
    assert.match(bridge, /transcription:\s*\{\s*model:\s*VOICE_TRANSCRIPTION_MODEL\s*\}/);
  });

  it('refuses to start when an operator points VOICE_MODEL at another model', () => {
    assert.doesNotThrow(() => assertPinnedVoiceModel({} as NodeJS.ProcessEnv));
    assert.doesNotThrow(() => assertPinnedVoiceModel({ VOICE_MODEL: 'gpt-realtime-2.1' } as NodeJS.ProcessEnv));
    for (const wrong of ['gpt-realtime-2.1-mini', 'gpt-4o-realtime-preview', '']) {
      assert.throws(
        () => assertPinnedVoiceModel({ VOICE_MODEL: wrong } as NodeJS.ProcessEnv),
        /VOICE_MODEL must be exactly gpt-realtime-2\.1/,
        `VOICE_MODEL=${JSON.stringify(wrong)} must fail startup`,
      );
    }
  });
});

describe('private voice HTTP surface', () => {
  it('exposes no confirmation or mutation route on the voice API', () => {
    const relay = readFileSync(join(root, 'src/server/relay.ts'), 'utf8');
    assert.doesNotMatch(relay, /api\/voice\/(confirm|defer|approve|send|action)/);
    for (const route of ['/api/voice/token', '/api/voice/call', '/api/voice/heartbeat', '/api/voice/status']) {
      assert.ok(relay.includes(route), `${route} must remain available`);
    }
  });

  it('marks every voice response no-store so credentials cannot be cached', () => {
    const relay = readFileSync(join(root, 'src/server/relay.ts'), 'utf8');
    assert.match(relay, /Cache-Control['"\s,]+.*no-store/);
  });
});
