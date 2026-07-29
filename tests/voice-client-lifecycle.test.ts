import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const VOICE_HTML = readFileSync(resolve('src/client/voice.html'), 'utf-8');
const VOICE_JS = readFileSync(resolve('src/client/voice.js'), 'utf-8');

interface RenderModel {
  state: string;
  stateText: string;
  buttonLabel: string;
  buttonDisabled: boolean;
  message: string;
  messageTone: string;
}

class FakeTrack {
  stopped = false;
  kind = 'audio';
  stop(): void { this.stopped = true; }
}

class FakeStream {
  readonly tracks: FakeTrack[];
  constructor(count = 2) {
    this.tracks = Array.from({ length: count }, () => new FakeTrack());
  }
  getTracks(): FakeTrack[] { return this.tracks; }
}

class FakeDataChannel {
  readonly sent: string[] = [];
  closed = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  send(value: string): void { this.sent.push(value); }
  close(): void { this.closed = true; }
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  closed = false;
  connectionState = 'new';
  addedTracks: FakeTrack[] = [];
  channel: FakeDataChannel | null = null;
  ontrack: ((event: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() { FakePeerConnection.instances.push(this); }

  createDataChannel(): FakeDataChannel {
    this.channel = new FakeDataChannel();
    return this.channel;
  }
  addTrack(track: FakeTrack): void { this.addedTracks.push(track); }
  async createOffer(): Promise<{ type: string; sdp: string }> { return { type: 'offer', sdp: 'v=0 offer' }; }
  async setLocalDescription(): Promise<void> { /* noop */ }
  async setRemoteDescription(): Promise<void> { /* noop */ }
  close(): void { this.closed = true; }

  /** Simulate an unintentional transport drop. */
  drop(): void {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }
}

interface HarnessOptions {
  micFails?: boolean;
  tokenStatus?: number;
  sdpStatus?: number;
  sdpLocation?: string | null;
  attachStatus?: number;
  heartbeatStatus?: number;
}

function createHarness(options: HarnessOptions = {}) {
  FakePeerConnection.instances = [];

  const dom = new JSDOM(VOICE_HTML, {
    url: 'https://relay.example.ts.net/voice',
    runScripts: 'dangerously',
  });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;

  const requests: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const beacons: Array<{ url: string; body: string }> = [];
  const renders: RenderModel[] = [];
  const consoleOutput: string[] = [];
  const streams: FakeStream[] = [];
  let mintCount = 0;

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    let parsedBody: unknown = null;
    if (typeof init.body === 'string' && init.headers && (init.headers as Record<string, string>)['Content-Type'] === 'application/json') {
      parsedBody = JSON.parse(init.body);
    }
    requests.push({ url, body: parsedBody ?? init.body ?? null, headers: (init.headers ?? {}) as Record<string, string> });

    if (url === '/api/voice/token') {
      if (options.tokenStatus && options.tokenStatus !== 200) return new Response('no', { status: options.tokenStatus });
      mintCount++;
      return new Response(JSON.stringify({
        clientSecret: `ephemeral-secret-${mintCount}`,
        expiresAt: 123,
        sessionId: `session-${mintCount}`,
        epoch: mintCount,
        attachToken: `attach-token-${mintCount}`,
      }), { status: 200 });
    }

    if (url.startsWith('https://api.openai.com/v1/realtime/calls')) {
      const status = options.sdpStatus ?? 200;
      const location = options.sdpLocation === undefined
        ? `https://api.openai.com/v1/realtime/calls/provider-call-${mintCount}`
        : options.sdpLocation;
      const headers = new Headers();
      if (location) headers.set('Location', location);
      return new Response('v=0 answer', { status, headers });
    }

    if (url === '/api/voice/call') {
      return new Response('{}', { status: options.attachStatus ?? 200 });
    }
    if (url === '/api/voice/heartbeat') {
      return new Response('{}', { status: options.heartbeatStatus ?? 200 });
    }
    if (url === '/api/voice/terminate') {
      return new Response(JSON.stringify({ state: 'terminated' }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const mediaDevices = {
    getUserMedia: async () => {
      if (options.micFails) throw new Error('NotAllowedError');
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
  };

  // Capture anything the controller would print, so the credential audit is real.
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (...args: unknown[]) => { consoleOutput.push(args.map(String).join(' ')); };
  console.log = capture; console.warn = capture; console.error = capture;
  try {
    win.eval(VOICE_JS);
  } finally {
    console.log = originalLog; console.warn = originalWarn; console.error = originalError;
  }

  const factory = win.createVoiceCallController as (env: unknown) => {
    toggle(): Promise<void>;
    start(): Promise<void>;
    hangUp(): Promise<void>;
    handlePageHide(): void;
    sendHeartbeat(): Promise<void>;
    getState(): string;
    getMessage(): string;
    hasCallIdentity(): boolean;
  };

  const timerCallbacks: Array<() => void> = [];
  let heartbeatHandle: number | null = null;

  const controller = factory({
    fetch: fetchImpl,
    mediaDevices,
    PeerConnection: FakePeerConnection,
    remoteAudio: dom.window.document.getElementById('remote-audio'),
    sendBeacon: (url: string, body: string) => { beacons.push({ url, body }); return true; },
    timers: {
      setInterval: (fn: () => void) => { timerCallbacks.push(fn); heartbeatHandle = timerCallbacks.length; return heartbeatHandle; },
      clearInterval: () => { heartbeatHandle = null; },
    },
    view: {
      render: (model: RenderModel) => {
        renders.push({ ...model });
        const doc = dom.window.document;
        doc.getElementById('call-state')!.textContent = model.stateText;
        const button = doc.getElementById('call-button') as HTMLButtonElement;
        button.textContent = model.buttonLabel;
        button.disabled = model.buttonDisabled;
        doc.getElementById('call-message')!.textContent = model.message;
      },
    },
  });

  return {
    controller,
    dom,
    requests,
    beacons,
    renders,
    consoleOutput,
    streams,
    urls: () => requests.map((r) => r.url),
    countOf: (url: string) => requests.filter((r) => r.url === url).length,
    peers: () => FakePeerConnection.instances,
    heartbeatActive: () => heartbeatHandle !== null,
    allTracksStopped: () => streams.every((s) => s.getTracks().every((t) => t.stopped)),
  };
}

describe('voice client — successful call', () => {
  it('reaches live only after media and sideband are both established', async () => {
    const h = createHarness();
    await h.controller.start();

    assert.equal(h.controller.getState(), 'live');
    assert.deepEqual(h.urls(), [
      '/api/voice/token',
      'https://api.openai.com/v1/realtime/calls',
      '/api/voice/call',
    ]);

    const attach = h.requests.find((r) => r.url === '/api/voice/call')!;
    assert.deepEqual(attach.body, {
      callId: 'provider-call-1',
      sessionId: 'session-1',
      epoch: 1,
      attachToken: 'attach-token-1',
    });
    assert.equal(h.heartbeatActive(), true, 'heartbeat starts once live');
  });

  it('passes through the connecting states in order', async () => {
    const h = createHarness();
    await h.controller.start();
    const states = h.renders.map((r) => r.state);
    assert.deepEqual(
      states.filter((s, i) => s !== states[i - 1]),
      ['idle', 'requesting_microphone', 'obtaining_secret', 'negotiating_webrtc', 'attaching_sideband', 'live'],
    );
  });

  it('sends the ephemeral credential only to the provider, never to the relay', async () => {
    const h = createHarness();
    await h.controller.start();

    const providerRequest = h.requests.find((r) => r.url.startsWith('https://api.openai.com'))!;
    assert.equal(providerRequest.headers.Authorization, 'Bearer ephemeral-secret-1');

    for (const request of h.requests.filter((r) => r.url.startsWith('/api/'))) {
      assert.equal(request.headers.Authorization, undefined, `${request.url} must not carry a credential`);
      assert.doesNotMatch(JSON.stringify(request.body ?? {}), /ephemeral-secret/);
    }
  });
});

describe('voice client — failure paths stop the microphone', () => {
  it('returns to a recoverable state when microphone permission is denied', async () => {
    const h = createHarness({ micFails: true });
    await h.controller.start();

    assert.equal(h.controller.getState(), 'error');
    assert.match(h.controller.getMessage(), /Microphone permission/i);
    // Recoverable: the button invites another attempt.
    assert.equal(h.renders.at(-1)!.buttonLabel, 'Call again');
    assert.equal(h.renders.at(-1)!.buttonDisabled, false);
  });

  it('stops already acquired tracks when the token request fails', async () => {
    const h = createHarness({ tokenStatus: 500 });
    await h.controller.start();

    assert.equal(h.controller.getState(), 'error');
    assert.equal(h.allTracksStopped(), true, 'the microphone must not stay live');
  });

  it('stops tracks and closes the peer when the provider rejects the call', async () => {
    const h = createHarness({ sdpStatus: 400 });
    await h.controller.start();

    assert.equal(h.controller.getState(), 'error');
    assert.equal(h.allTracksStopped(), true);
    assert.equal(h.peers()[0].closed, true, 'the peer connection must be closed');
  });

  it('fails closed when the provider returns no usable call id', async () => {
    const h = createHarness({ sdpLocation: null });
    await h.controller.start();

    assert.equal(h.controller.getState(), 'error');
    assert.equal(h.allTracksStopped(), true);
    assert.equal(h.countOf('/api/voice/call'), 0, 'no attach may be attempted without a call id');
  });

  it('tears down and tells the relay when sideband attach fails', async () => {
    const h = createHarness({ attachStatus: 409 });
    await h.controller.start();

    assert.equal(h.controller.getState(), 'error');
    assert.equal(h.allTracksStopped(), true);
    assert.equal(h.peers()[0].closed, true);
    assert.equal(h.countOf('/api/voice/terminate'), 1, 'the relay must be told to end the provider call');
  });
});

describe('voice client — explicit hang up', () => {
  it('closes everything and calls the relay exactly once', async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.hangUp();

    assert.equal(h.controller.getState(), 'ended');
    assert.equal(h.allTracksStopped(), true);
    assert.equal(h.peers()[0].closed, true);
    assert.equal(h.peers()[0].channel!.closed, true);
    assert.equal(h.countOf('/api/voice/terminate'), 1);
    assert.equal(h.heartbeatActive(), false, 'heartbeat stops on a terminal state');
    assert.equal(h.controller.hasCallIdentity(), false, 'call identity is cleared from memory');
  });

  it('never reconnects after an explicit hang up', async () => {
    const h = createHarness();
    await h.controller.start();
    const peer = h.peers()[0];
    await h.controller.hangUp();

    // A late transport failure from the old peer must be ignored.
    peer.drop();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(h.controller.getState(), 'ended');
    assert.equal(h.peers().length, 1, 'no second call may be created');
    assert.equal(h.countOf('/api/voice/token'), 1);
  });

  it('is idempotent when hang up is pressed twice', async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.hangUp();
    await h.controller.hangUp();

    assert.equal(h.countOf('/api/voice/terminate'), 1);
    assert.equal(h.controller.getState(), 'ended');
  });
});

describe('voice client — concurrency', () => {
  it('a double tap cannot create two concurrent calls', async () => {
    const h = createHarness();
    await Promise.all([h.controller.toggle(), h.controller.toggle()]);

    assert.equal(h.countOf('/api/voice/token'), 1, 'only one credential may be minted');
    assert.equal(h.peers().length, 1, 'only one peer connection may exist');
    assert.equal(h.controller.getState(), 'live');
  });

  it('toggling while live hangs up instead of starting a second call', async () => {
    const h = createHarness();
    await h.controller.toggle();
    assert.equal(h.controller.getState(), 'live');

    await h.controller.toggle();
    assert.equal(h.controller.getState(), 'ended');
    assert.equal(h.countOf('/api/voice/token'), 1);
  });
});

describe('voice client — reconnect', () => {
  it('makes exactly one bounded retry with a fresh credential and epoch', async () => {
    const h = createHarness();
    await h.controller.start();

    h.peers()[0].drop();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(h.controller.getState(), 'live');
    assert.equal(h.countOf('/api/voice/token'), 2, 'reconnect must mint a fresh credential');

    const attaches = h.requests.filter((r) => r.url === '/api/voice/call');
    assert.equal((attaches[1].body as { epoch: number }).epoch, 2, 'reconnect uses a new epoch');
    assert.notEqual(
      (attaches[0].body as { attachToken: string }).attachToken,
      (attaches[1].body as { attachToken: string }).attachToken,
      'the old attach token is never reused',
    );
  });

  it('gives up after the bounded retry rather than looping', async () => {
    const h = createHarness();
    await h.controller.start();

    h.peers()[0].drop();
    await new Promise((r) => setTimeout(r, 0));
    h.peers()[1].drop();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(h.controller.getState(), 'error');
    assert.equal(h.countOf('/api/voice/token'), 2, 'no third attempt');
    assert.equal(h.allTracksStopped(), true);
    assert.equal(h.heartbeatActive(), false);
  });
});

describe('voice client — server hangup and unload', () => {
  it('cleans up locally when the relay reports the session is gone', async () => {
    const h = createHarness({ heartbeatStatus: 409 });
    await h.controller.start();
    await h.controller.sendHeartbeat();

    assert.equal(h.controller.getState(), 'ended');
    assert.match(h.controller.getMessage(), /ended by the server/i);
    assert.equal(h.allTracksStopped(), true);
    assert.equal(h.heartbeatActive(), false);
  });

  it('never reconnects after a server-side hangup', async () => {
    const h = createHarness({ heartbeatStatus: 409 });
    await h.controller.start();
    const peer = h.peers()[0];
    await h.controller.sendHeartbeat();

    peer.drop();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(h.countOf('/api/voice/token'), 1, 'a server hangup must not be retried');
    assert.equal(h.controller.getState(), 'ended');
  });

  it('performs best-effort cleanup on pagehide without depending on delivery', async () => {
    const h = createHarness();
    await h.controller.start();

    h.controller.handlePageHide();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(h.allTracksStopped(), true, 'the microphone must be released when the page hides');
    assert.equal(h.peers()[0].closed, true);
    assert.equal(h.beacons.length, 1);
    assert.equal(h.beacons[0].url, '/api/voice/terminate');
  });
});

describe('voice client — barge-in', () => {
  it('cancels the in-flight response when the user starts speaking', async () => {
    const h = createHarness();
    await h.controller.start();
    const channel = h.peers()[0].channel!;

    channel.deliver({ type: 'response.output_audio.delta' });
    assert.equal(h.controller.getState(), 'speaking');

    channel.deliver({ type: 'input_audio_buffer.speech_started' });
    assert.equal(h.controller.getState(), 'live');
    assert.deepEqual(channel.sent.map((raw) => JSON.parse(raw).type), ['response.cancel']);
  });

  it('ignores malformed provider events', async () => {
    const h = createHarness();
    await h.controller.start();
    const channel = h.peers()[0].channel!;

    channel.onmessage!({ data: 'not json' });
    channel.deliver({ nope: true });

    assert.equal(h.controller.getState(), 'live');
  });
});

describe('voice client — credential hygiene', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(async () => {
    harness = createHarness();
    await harness.controller.start();
  });

  it('leaves no credential in the DOM', () => {
    const html = harness.dom.window.document.documentElement.outerHTML;
    assert.doesNotMatch(html, /ephemeral-secret|attach-token/);
  });

  it('writes no credential to browser storage', () => {
    assert.equal(harness.dom.window.localStorage.length, 0);
    assert.equal(harness.dom.window.sessionStorage.length, 0);
  });

  it('logs no credential', () => {
    const output = harness.consoleOutput.join('\n');
    assert.doesNotMatch(output, /ephemeral-secret|attach-token|Bearer/i);
  });

  it('puts no credential in any URL', () => {
    for (const request of harness.requests) {
      assert.doesNotMatch(request.url, /ephemeral-secret|attach-token/);
    }
  });
});

describe('voice client — surface scope', () => {
  it('renders only the call screen, with no approval or command controls', () => {
    const doc = new JSDOM(VOICE_HTML).window.document;
    assert.ok(doc.getElementById('call-button'));
    assert.ok(doc.getElementById('call-state'));

    assert.equal(doc.querySelectorAll('input, textarea, select, form').length, 0);
    assert.equal(doc.querySelectorAll('button').length, 1, 'exactly one control');
    assert.doesNotMatch(doc.body.textContent ?? '', /approve|reject|model|settings|transcript/i);
  });

  it('declares the installable online-only PWA metadata', () => {
    const doc = new JSDOM(VOICE_HTML).window.document;
    assert.equal(doc.querySelector('link[rel="manifest"]')?.getAttribute('href'), '/manifest.webmanifest');
    assert.ok(doc.querySelector('meta[name="viewport"]'));
    assert.ok(doc.querySelector('meta[name="apple-mobile-web-app-capable"]'));

    const manifest = JSON.parse(readFileSync(resolve('src/client/manifest.webmanifest'), 'utf-8'));
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, '/voice');
    assert.equal(manifest.orientation, 'portrait');
    assert.ok(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable'));
  });
});
