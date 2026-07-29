import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * Runtime harness for the browser voice controller.
 *
 * The real `src/client/voice.js` is evaluated inside JSDOM and driven through
 * its injected environment, so every assertion built on this helper is about
 * observed behaviour — which fetches were issued, which peer was closed, which
 * tracks were stopped — never about the shape of the source text.
 */

export const VOICE_HTML = readFileSync(resolve('src/client/voice.html'), 'utf-8');
export const VOICE_JS = readFileSync(resolve('src/client/voice.js'), 'utf-8');

export interface RenderModel {
  state: string;
  stateText: string;
  buttonLabel: string;
  buttonDisabled: boolean;
  message: string;
  messageTone: string;
}

export class FakeTrack {
  stopped = false;
  stopCount = 0;
  kind = 'audio';
  stop(): void { this.stopped = true; this.stopCount++; }
}

export class FakeStream {
  readonly tracks: FakeTrack[];
  constructor(count = 2) {
    this.tracks = Array.from({ length: count }, () => new FakeTrack());
  }
  getTracks(): FakeTrack[] { return this.tracks; }
}

export class FakeDataChannel {
  readonly sent: string[] = [];
  closed = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  send(value: string): void { this.sent.push(value); }
  close(): void { this.closed = true; }
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

export class FakePeerConnection {
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

  /**
   * Fire this instance's own connection-state callback, exactly as the browser
   * does: the event belongs to the connection that emitted it, whether or not
   * that connection is still the one the controller is using.
   */
  signal(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  /** Simulate an unintentional transport drop. */
  drop(): void { this.signal('failed'); }
}

export interface HarnessOptions {
  micFails?: boolean;
  tokenStatus?: number;
  sdpStatus?: number;
  sdpLocation?: string | null;
  attachStatus?: number;
  heartbeatStatus?: number;
  /**
   * Hold `/api/voice/token` until this settles, so a test can act on the
   * controller while it is mid-start rather than after it has gone live.
   */
  holdToken?: Promise<unknown>;
}

export function createHarness(options: HarnessOptions = {}) {
  FakePeerConnection.instances = [];

  const dom = new JSDOM(VOICE_HTML, {
    url: 'https://relay.example.ts.net/voice',
    runScripts: 'dangerously',
  });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;

  const requests: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  // sendBeacon carries a Blob so the relay sees a parseable content type; the
  // body is kept unknown here so the test asserts what was actually sent.
  const beacons: Array<{ url: string; body: unknown }> = [];
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
      if (options.holdToken) await options.holdToken;
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
    handleTransportFailure(): Promise<void>;
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
    sendBeacon: (url: string, body: unknown) => { beacons.push({ url, body }); return true; },
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
    /** Every local track across every stream this call ever acquired. */
    allTracks: () => streams.flatMap((s) => s.getTracks()),
  };
}

export type VoiceClientHarness = ReturnType<typeof createHarness>;
