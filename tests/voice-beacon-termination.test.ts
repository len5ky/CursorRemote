import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { startVoiceRelay, type VoiceRelayHarness } from './helpers/voice-relay-harness.js';

/**
 * `navigator.sendBeacon(url, string)` is delivered as
 * `text/plain;charset=UTF-8`, which express.json() does not parse — so the
 * pagehide hangup silently 400'd and the session survived until the reaper.
 * Both halves are pinned here: the browser must send a payload the relay
 * parses, and the relay must actually terminate on it.
 */

const VOICE_HTML = readFileSync(resolve('src/client/voice.html'), 'utf-8');
const VOICE_JS = readFileSync(resolve('src/client/voice.js'), 'utf-8');

interface BeaconRecord { url: string; body: unknown }

async function beaconPayload(record: BeaconRecord): Promise<{ type: string; text: string }> {
  const body = record.body as { type?: string; text?(): Promise<string> } | string;
  if (typeof body === 'string') return { type: 'text/plain', text: body };
  assert.equal(typeof body.text, 'function', 'a beacon body must be a Blob or a string');
  return { type: body.type ?? '', text: await body.text!() };
}

/** Minimal jsdom controller harness — just enough to reach `live` and hide the page. */
function createClientHarness() {
  const dom = new JSDOM(VOICE_HTML, { url: 'https://relay.example.ts.net/voice', runScripts: 'dangerously' });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  const beacons: BeaconRecord[] = [];

  const fetchImpl = async (input: string): Promise<Response> => {
    const url = String(input);
    if (url === '/api/voice/token') {
      return new Response(JSON.stringify({
        clientSecret: 'ephemeral-secret', expiresAt: 123,
        sessionId: 'session-beacon', epoch: 7, attachToken: 'attach-token-beacon',
      }), { status: 200 });
    }
    if (url.startsWith('https://api.openai.com/v1/realtime/calls')) {
      return new Response('v=0 answer', {
        status: 200,
        headers: { Location: 'https://api.openai.com/v1/realtime/calls/provider-call-beacon' },
      });
    }
    return new Response('{}', { status: 200 });
  };

  class FakeTrack { stopped = false; stop(): void { this.stopped = true; } }
  class FakeStream { tracks = [new FakeTrack()]; getTracks(): FakeTrack[] { return this.tracks; } }
  class FakePeerConnection {
    connectionState = 'new';
    ontrack: unknown = null;
    onconnectionstatechange: (() => void) | null = null;
    createDataChannel(): { send(): void; close(): void; onmessage: unknown } {
      return { send: () => {}, close: () => {}, onmessage: null };
    }
    addTrack(): void { /* noop */ }
    async createOffer(): Promise<{ type: string; sdp: string }> { return { type: 'offer', sdp: 'v=0 offer' }; }
    async setLocalDescription(): Promise<void> { /* noop */ }
    async setRemoteDescription(): Promise<void> { /* noop */ }
    close(): void { /* noop */ }
  }

  win.eval(VOICE_JS);

  const factory = win.createVoiceCallController as (env: unknown) => {
    start(): Promise<void>;
    handlePageHide(): void;
    getState(): string;
  };

  const controller = factory({
    fetch: fetchImpl,
    mediaDevices: { getUserMedia: async () => new FakeStream() },
    PeerConnection: FakePeerConnection,
    remoteAudio: null,
    sendBeacon: (url: string, body: unknown) => { beacons.push({ url, body }); return true; },
    timers: { setInterval: () => 1, clearInterval: () => {} },
    view: { render: () => {} },
  });

  return { controller, beacons, dom };
}

describe('voice pagehide beacon — browser payload', () => {
  it('sends a JSON-typed beacon carrying sessionId and epoch', async () => {
    assert.ok(VOICE_JS.includes('sendBeacon'), 'the client still owns the pagehide beacon');
    const h = createClientHarness();
    await h.controller.start();
    assert.equal(h.controller.getState(), 'live');

    h.controller.handlePageHide();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(h.beacons.length, 1);
    assert.equal(h.beacons[0].url, '/api/voice/terminate');

    const payload = await beaconPayload(h.beacons[0]);
    assert.match(payload.type, /^application\/json/, 'the beacon must declare a content type the relay parses');

    const parsed = JSON.parse(payload.text) as { sessionId: string; epoch: number; reason: string };
    assert.equal(parsed.sessionId, 'session-beacon');
    assert.equal(parsed.epoch, 7);
    assert.equal(parsed.reason, 'page_hidden');

    h.dom.window.close();
  });
});

describe('voice pagehide beacon — relay termination', () => {
  const harnesses: VoiceRelayHarness[] = [];
  after(async () => { for (const h of harnesses) await h.close(); });

  async function liveSession(): Promise<{ h: VoiceRelayHarness; cookie: string; sessionId: string; epoch: number }> {
    const h = await startVoiceRelay();
    harnesses.push(h);
    const cookie = await h.login();
    const minted = await fetch(`${h.baseUrl}/api/voice/token`, { method: 'POST', headers: { cookie } });
    assert.equal(minted.status, 200);
    const body = await minted.json() as { sessionId: string; epoch: number; attachToken: string };
    const attached = await fetch(`${h.baseUrl}/api/voice/call`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: 'provider-call-beacon', sessionId: body.sessionId, epoch: body.epoch, attachToken: body.attachToken }),
    });
    assert.equal(attached.status, 200);
    return { h, cookie, sessionId: body.sessionId, epoch: body.epoch };
  }

  it('terminates on a text/plain beacon body (the sendBeacon string default)', async () => {
    const { h, cookie, sessionId, epoch } = await liveSession();

    const response = await h.raw({
      method: 'POST',
      path: '/api/voice/terminate',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', Cookie: cookie },
      body: JSON.stringify({ sessionId, epoch, reason: 'page_hidden' }),
    });
    assert.equal(response.status, 200, 'a text/plain beacon must be parsed, not 400');

    const result = JSON.parse(response.body) as { sessionId: string; epoch: number; state: string; reason: string };
    assert.equal(result.sessionId, sessionId, 'the endpoint received the sessionId');
    assert.equal(result.epoch, epoch, 'the endpoint received the epoch');
    assert.equal(result.reason, 'page_hidden');
    assert.equal(result.state, 'terminated', 'the beacon actually triggered termination');

    assert.ok(h.providerCalls.some((u) => u.includes('/hangup')), 'termination reached the provider hangup');

    const heartbeat = await fetch(`${h.baseUrl}/api/voice/heartbeat`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, epoch }),
    });
    assert.equal(heartbeat.status, 409, 'the lease is gone after the beacon');
  });

  it('terminates on an application/json beacon body (Blob sendBeacon)', async () => {
    const { h, cookie, sessionId, epoch } = await liveSession();

    const response = await h.raw({
      method: 'POST',
      path: '/api/voice/terminate',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ sessionId, epoch, reason: 'page_hidden' }),
    });
    assert.equal(response.status, 200);
    assert.equal((JSON.parse(response.body) as { state: string }).state, 'terminated');
  });

  it('still rejects an unparseable beacon body instead of guessing', async () => {
    const { h, cookie } = await liveSession();
    const response = await h.raw({
      method: 'POST',
      path: '/api/voice/terminate',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', Cookie: cookie },
      body: 'not json at all',
    });
    assert.equal(response.status, 400);
  });
});
