import { createHash } from 'crypto';
import WebSocket, { type ClientOptions } from 'ws';
import type { VoiceConfig } from '../../types.js';
import {
  VOICE_MAX_INTERRUPTED_RENDER_MEMORY,
  VOICE_MAX_ITEM_ID_BYTES,
  VOICE_MAX_PROVIDER_EVENT_BYTES,
  VOICE_MAX_PROVIDER_FRAME_BYTES,
  VOICE_MAX_TRANSCRIPT_ITEM_MEMORY,
  VOICE_REALTIME_MODEL,
  VOICE_TRANSCRIPTION_MODEL,
} from './constants.js';
import {
  VOICE_HERMES_MAX_ASSISTANT_BYTES,
  normalizeVoiceTranscript,
  type VoiceHermesSpeechSource,
} from './hermes-chat.js';
import { boundedText } from './text.js';
import type { VoiceSessionContext } from './session.js';

/**
 * DICKTATOR Realtime bridge — OpenAI Realtime API (GA interface).
 *
 * The provider is ears and mouth. It never answers anything.
 *
 * Call path:
 *  1. Browser asks the relay for a client secret → mintClientSecret() POSTs to
 *     /v1/realtime/client_secrets with the real API key (server-side only).
 *  2. Browser opens a WebRTC session directly to OpenAI at /v1/realtime/calls
 *     using the ephemeral token; audio never transits our server.
 *  3. Browser reports only call_id back to the relay → attachSideband() opens
 *     wss://api.openai.com/v1/realtime?call_id=… using the server-held standard
 *     project key. The browser secret never crosses back through the relay.
 *  4. The provider transcribes the operator's speech. On the FINAL transcript
 *     the relay sends that exact text to the private Hermes deployment,
 *     server-to-server, and Hermes' answer is the only conversational content.
 *  5. That answer is rendered as audio by an out-of-band `response.create`
 *     carrying the Hermes text as explicit custom input, with instructions to
 *     read only that text.
 *
 * The provider is configured with no tools, `tool_choice: 'none'`, and server
 * VAD that neither creates nor interrupts responses, so there is no path by
 * which it can answer on its own.
 */

const OPENAI_BASE = 'https://api.openai.com/v1/realtime';
const OPENAI_WS_BASE = 'wss://api.openai.com/v1/realtime';
const HANGUP_ATTEMPTS = 3;
const HANGUP_RETRY_DELAY_MS = 100;

/**
 * Response lifecycle statuses that mean nothing was spoken.
 *
 * `cancelled` is deliberately absent: the relay cancels superseded renderings
 * itself, and treating its own barge-in as a provider fault would end a call
 * every time the operator interrupted.
 */
const FAILED_RESPONSE_STATUSES: readonly string[] = ['failed', 'rejected'];

/**
 * Session instructions. These describe the *only* job the provider has; they
 * are not, and are never treated as, a security boundary — the boundary is the
 * empty tool list, `tool_choice: 'none'` and VAD that cannot create a response.
 */
export const VOICE_INSTRUCTIONS =
  'You are the audio interface for a private assistant. '
  + 'You do not answer questions and you have no knowledge of your own. '
  + 'You transcribe what the operator says, and you read aloud text you are explicitly given. '
  + 'Never add, summarise, translate, correct or continue that text.';

/**
 * Per-response instructions for a Hermes rendering turn.
 *
 * The response carries exactly one piece of custom input — the validated Hermes
 * answer — and the model's whole task is to voice it.
 */
export const VOICE_RENDER_INSTRUCTIONS =
  'Read only the provided message aloud, verbatim, in a natural speaking voice, and say nothing else. '
  + 'Do not answer it, do not comment on it, do not add or omit anything.';

export interface ClientSecretResult {
  clientSecret: string;
  expiresAt?: number;
}

export type SelectedModelVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Every model a payload declares, wherever it declares one.
 *
 * The Realtime interface reports the selected model in more than one place
 * depending on the payload — `session.created` carries `session.model`, and a
 * client-secret response carries the echoed session config it minted. Reading
 * only one of them meant a payload that disagreed with itself could pass by
 * declaring the pin in the place that was checked and something else in the
 * place that was not.
 */
function collectDeclaredModels(value: unknown, depth = 0): unknown[] {
  const record = asRecord(value);
  if (!record || depth > 2) return [];
  const declared: unknown[] = [];
  if ('model' in record) declared.push(record.model);
  for (const key of ['session', 'realtime'] as const) {
    if (key in record) declared.push(...collectDeclaredModels(record[key], depth + 1));
  }
  return declared;
}

/**
 * Confirm a provider payload selected exactly the pinned model.
 *
 * The pin is only real if the session that actually came up is on it. A wrong
 * model is a different product; an *undeclared* model is the same risk with no
 * evidence either way, and "the response did not say" is not evidence that the
 * pin held — so both fail closed, and a payload declaring two different models
 * fails on the one that does not match.
 */
export function verifySelectedModel(value: unknown): SelectedModelVerdict {
  const declared = collectDeclaredModels(value);
  if (declared.length === 0) return { ok: false, reason: 'provider_model_undeclared' };
  if (declared.some((model) => model !== VOICE_REALTIME_MODEL)) {
    return { ok: false, reason: 'provider_model_mismatch' };
  }
  return { ok: true };
}

export interface RealtimeBridgeOptions {
  fetchImpl?: typeof fetch;
  websocketFactory?: (url: string, options: ClientOptions) => WebSocket;
}

/** Stable, privacy-safe identifier sent to OpenAI; the raw account key never leaves the relay. */
export function safetyIdentifierForAccount(accountKey: string): string {
  return createHash('sha256').update(accountKey).digest('hex');
}

/** Extract the provider call id from the standard Location response header. */
export function extractCallId(headers: Headers | { get(name: string): string | null }): string | null {
  const location = headers.get('location');
  if (!location) return null;
  const match = location.match(/\/calls\/([^/?#]+)(?:[/?#]|$)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export interface RealtimeBridgeAuthority {
  accepts(context: VoiceSessionContext): boolean;
  userTurn(context: VoiceSessionContext): void;
  providerFailure(context: VoiceSessionContext, reason: string): void;
  reportSpend(context: VoiceSessionContext, cents: number, source: 'estimated' | 'reported'): boolean;
}

export function parseUsageFromDone(raw: string): { reportedCents?: number; audioDurationMs?: number } | null {
  let event: { type?: string; response?: { usage?: { cost_cents?: number; total_cost_cents?: number; cost?: { cents?: number }; output_tokens?: { audio_duration_ms?: number; text_duration_ms?: number } } } };
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (event.type !== 'response.done') return null;
  const usage = event.response?.usage;
  if (!usage) return null;
  const audioDurationMs = usage.output_tokens?.audio_duration_ms;
  const cents = usage.cost_cents ?? usage.total_cost_cents ?? usage.cost?.cents;
  const result: { reportedCents?: number; audioDurationMs?: number } = {};
  // Only provider-supplied cents are reported; duration priced locally remains an estimate.
  if (typeof cents === 'number' && Number.isFinite(cents) && cents >= 0) result.reportedCents = cents;
  if (typeof audioDurationMs === 'number' && Number.isFinite(audioDurationMs) && audioDurationMs > 0) result.audioDurationMs = audioDurationMs;
  return result.reportedCents === undefined && result.audioDurationMs === undefined ? null : result;
}

export function buildSessionConfig(config: VoiceConfig): Record<string, unknown> {
  return {
    session: {
      type: 'realtime',
      model: VOICE_REALTIME_MODEL,
      instructions: VOICE_INSTRUCTIONS,
      audio: {
        input: {
          // Transcription is the sole trigger for a Hermes turn.
          transcription: { model: VOICE_TRANSCRIPTION_MODEL },
          // Server VAD segments speech only. It must not author a response, and
          // it must not interrupt one: the relay decides when a turn is stale
          // and cancels it explicitly, so a cough cannot silence Hermes' answer
          // while a genuinely new question can.
          turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false },
        },
        output: { voice: config.voice },
      },
      // No conversational tools exist on this surface, and nothing may choose one.
      tools: [],
      tool_choice: 'none',
    },
  };
}

interface PendingTurn {
  id: number;
  itemId: string;
  abort: AbortController;
}

export class RealtimeBridge {
  private config: VoiceConfig;
  private hermes: VoiceHermesSpeechSource;
  private authority: RealtimeBridgeAuthority;
  private ws: WebSocket | null = null;
  private callId: string | null = null;
  private context: VoiceSessionContext | null = null;
  private readonly closedByUs = new WeakSet<WebSocket>();
  private readonly fetchImpl: typeof fetch;
  private readonly websocketFactory: (url: string, options: ClientOptions) => WebSocket;

  /** Monotonic across the life of this bridge; never reused, never rewound. */
  private turnId = 0;
  private pendingTurn: PendingTurn | null = null;
  /** Provider id of the rendering response currently being spoken, if any. */
  private renderingResponseId: string | null = null;
  /**
   * Turn id of the one rendering response the relay has asked for and not yet
   * seen acknowledged. Null means the relay is not expecting the provider to
   * start speaking at all, so anything it starts is unauthorised.
   */
  private awaitedRenderTurnId: number | null = null;
  /**
   * Renderings that were asked for and then superseded before the provider
   * acknowledged them.
   *
   * Barge-in can land in the window between `response.create` and
   * `response.created`. Clearing `awaitedRenderTurnId` alone left that window
   * with no memory at all: the acknowledgement still arrived, matched nothing,
   * and was handled as an unauthorised response — cancelled, but also failing
   * the whole call over what is simply an operator interrupting quickly. The
   * latch keeps the turn id, so the late acknowledgement is recognised as the
   * abandoned rendering it is, cancelled by id on arrival, and never adopted as
   * the response being spoken.
   */
  private readonly interruptedRenderTurns = new Set<number>();
  private readonly handledTranscriptItems = new Set<string>();

  constructor(
    config: VoiceConfig,
    hermes: VoiceHermesSpeechSource,
    authority: RealtimeBridgeAuthority,
    options: RealtimeBridgeOptions = {},
  ) {
    this.config = config;
    this.hermes = hermes;
    this.authority = authority;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.websocketFactory = options.websocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connectedFor(context: VoiceSessionContext): boolean {
    return this.connected && this.sameContext(context, this.context);
  }

  /** Mint an ephemeral client secret so the browser can connect via WebRTC. */
  async mintClientSecret(accountKey: string): Promise<ClientSecretResult> {
    if (!this.config.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');
    const resp = await this.fetchImpl(`${OPENAI_BASE}/client_secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...buildSessionConfig(this.config),
        safety_identifier: safetyIdentifierForAccount(accountKey),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      throw new Error(`client_secrets failed: HTTP ${resp.status}`);
    }
    const data = await resp.json() as {
      value?: string;
      client_secret?: { value?: string };
      expires_at?: number;
      model?: unknown;
      session?: unknown;
    };
    const value = data.value ?? data.client_secret?.value;
    if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
      throw new Error('client_secrets response missing secret value');
    }
    // This credential is what the browser opens its session with, so the model
    // it was minted against is the model the operator will actually be talking
    // to. A secret whose response does not say — or does not agree — is
    // discarded here rather than handed out: once the browser has it, the relay
    // has no say in what session it opens.
    const model = verifySelectedModel(data);
    if (!model.ok) {
      throw new Error(`client_secrets response failed model validation (${model.reason})`);
    }
    return { clientSecret: value, expiresAt: data.expires_at };
  }

  /**
   * Attach a server-side sideband WebSocket to a browser-initiated WebRTC call.
   * Transcripts arrive here and rendering responses are created here, so the
   * browser client stays dumb: it owns no turn state and creates no responses.
   */
  attachSideband(callId: string, context: VoiceSessionContext): Promise<void> {
    this.detach();
    this.callId = callId;
    this.context = context;

    if (!this.config.openaiApiKey) throw new Error('OPENAI_API_KEY not configured');

    return new Promise((resolve, reject) => {
      const ws = this.websocketFactory(`${OPENAI_WS_BASE}?call_id=${encodeURIComponent(callId)}`, {
        headers: { Authorization: `Bearer ${this.config.openaiApiKey}` },
        maxPayload: VOICE_MAX_PROVIDER_FRAME_BYTES,
      });
      this.ws = ws;

      // Every terminal path — open, error, close, timeout — routes through
      // `settle`, so the attach promise resolves or rejects exactly once. A
      // socket that closed *before* it ever opened used to settle nothing at
      // all: the caller's HTTP request hung for the full 15s connect timer over
      // a connection that was already gone, while the session it had just
      // activated stayed activated.
      let settled = false;
      let opened = false;
      let failureReported = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      /** One dead socket is one failure, however many events it emits on the way down. */
      const reportFailure = (reason: string): void => {
        if (failureReported || this.closedByUs.has(ws)) return;
        failureReported = true;
        this.authority.providerFailure(context, reason);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settle(new Error('Sideband WS connect timeout'));
        this.authority.providerFailure(context, 'sideband_connect_timeout');
        failureReported = true;
        this.closedByUs.add(ws);
        try { ws.close(); } catch { /* ok */ }
      }, 15_000);

      ws.on('open', () => {
        opened = true;
        console.log(`[dicktator] Sideband attached (call ${callId.substring(0, 12)}...)`);
        settle();
      });
      ws.on('message', (raw) => {
        if (!this.authority.accepts(context)) return;
        void this.onServerEvent(raw.toString(), context).catch(() =>
          console.error('[voice] Sideband event handling failed')
        );
      });
      ws.on('error', () => {
        console.error('[voice] Sideband WebSocket error');
        settle(new Error('Sideband WebSocket connection failed'));
        reportFailure('sideband_error');
      });
      ws.on('close', () => {
        // Release only the socket. `callId` and `context` stay put: the browser
        // did create a provider call, and termination needs the id to hang it
        // up. Dropping them here would report `no_provider_call` and orphan a
        // live, billable call at the provider.
        if (this.ws === ws) this.ws = null;
        if (!this.closedByUs.has(ws)) console.log('[dicktator] Sideband WS closed');
        settle(new Error('Sideband WebSocket closed before it opened'));
        reportFailure(opened ? 'sideband_closed' : 'sideband_closed_before_open');
      });
    });
  }

  detach(context?: VoiceSessionContext): string | null {
    if (context && !this.sameContext(context, this.context)) return null;
    const callId = this.callId;
    // Invalidate any turn in flight. A Hermes answer that lands after this must
    // never be spoken — the call it belonged to is gone.
    this.abandonPendingTurn();
    this.renderingResponseId = null;
    this.awaitedRenderTurnId = null;
    this.handledTranscriptItems.clear();
    if (this.ws) {
      this.closedByUs.add(this.ws);
      try { this.ws.close(); } catch { /* ok */ }
      this.ws = null;
    }
    this.callId = null;
    this.context = null;
    return callId;
  }

  async hangup(callId: string): Promise<boolean> {
    if (!this.config.openaiApiKey) return false;
    for (let attempt = 0; attempt < HANGUP_ATTEMPTS; attempt++) {
      try {
        const response = await this.fetchImpl(`${OPENAI_BASE}/calls/${encodeURIComponent(callId)}/hangup`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.config.openaiApiKey}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) return true;
      } catch {
        // Retry transient network and timeout failures.
      }
      if (attempt + 1 < HANGUP_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, HANGUP_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
    return false;
  }

  private send(event: Record<string, unknown>, context?: VoiceSessionContext): void {
    if (context ? !this.connectedFor(context) : !this.connected) return;
    this.ws!.send(JSON.stringify(event));
  }

  private async onServerEvent(raw: string, context: VoiceSessionContext): Promise<void> {
    // Oversize provider input is refused, not fatal: the event is dropped and
    // the sideband, session and lease all continue. Byte length (not UTF-16
    // code units) is what the ws frame ceiling bounds, so measure the same way.
    if (Buffer.byteLength(raw, 'utf8') > VOICE_MAX_PROVIDER_EVENT_BYTES) {
      console.warn('[voice] Dropped an oversized provider event');
      return;
    }
    if (!this.authority.accepts(context)) return;
    let event: { type?: string; [key: string]: unknown };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }

    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        // The session the provider actually created is the last place the model
        // pin can be checked against reality. A session that came up on some
        // other model is a different product with a live microphone attached,
        // so it is refused before the relay re-asserts anything — sending the
        // config first would have handed a permissive `session.update` to a
        // session this surface has already decided it cannot use.
        const model = verifySelectedModel(asRecord(event.session));
        if (!model.ok) {
          console.error('[voice] Provider session model failed validation; the call is refused');
          this.failCall(context, model.reason);
          break;
        }
        // Re-assert the full config on the sideband in case the ephemeral
        // session config was minimal: no tools, no tool choice, transcription
        // on, VAD that cannot answer.
        if (event.type === 'session.created') {
          this.send({ type: 'session.update', ...buildSessionConfig(this.config) }, context);
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        await this.onFinalTranscript(event, context);
        break;
      }

      case 'response.function_call_arguments.done':
      case 'response.function_call_arguments.delta': {
        // The session declares no tools and `tool_choice: 'none'`, so a function
        // call cannot legitimately occur. Answering it would mean writing a tool
        // output for a tool this surface does not have. The honest outcome is a
        // bounded failure and a hangup.
        console.warn('[voice] Refused a provider tool call; the voice session declares no tools');
        this.authority.providerFailure(context, 'provider_tool_call_refused');
        break;
      }

      case 'input_audio_buffer.speech_started': {
        // Barge-in, decided server-side.
        //
        // The operator has started talking. Whatever this call was still doing
        // on their behalf is now about a question they have moved on from, so
        // the outstanding Hermes fetch is aborted and any Hermes rendering the
        // provider is speaking is cancelled by id.
        //
        // This cannot be left to the browser. The browser's data channel is
        // best-effort and unauthenticated as an authority: it can send
        // `response.cancel` to stop audio it can hear, but it does not know a
        // Hermes fetch is in flight, cannot abort it, and a late answer would
        // still arrive at the relay and be spoken over the operator. The relay
        // owns the turn, so the relay ends it.
        //
        // Deliberately NOT a Hermes trigger: speech starting is sound, not
        // language. Only a completed transcript says anything.
        this.authority.userTurn(context);
        this.interruptTurn(context);
        break;
      }

      case 'input_audio_buffer.committed': {
        // Activity, for idleness only. A commit is not a transcript and must
        // never start a Hermes turn — the text is not known yet.
        this.authority.userTurn(context);
        break;
      }

      case 'response.created': {
        // The provider has started speaking. Only one thing on this surface is
        // ever allowed to: the rendering the relay itself just asked for, for
        // the turn it is still waiting on.
        //
        // Anything else — untagged, mistagged, malformed, or tagged for a turn
        // that has already been superseded — is audio the operator would hear
        // in this assistant's voice from a source that is not Hermes. Merely
        // declining to *remember* it left it playing to the end, which is the
        // silent failure this fails closed on: the response is cancelled and
        // the call is failed, once.
        //
        // An untrusted response is deliberately never written to
        // `renderingResponseId`, so its id cannot become the target of a later
        // cancel and take a genuine Hermes rendering down with it.
        const response = asRecord(event.response);
        const responseId = boundedText(response?.id, VOICE_MAX_ITEM_ID_BYTES);
        const metadata = asRecord(response?.metadata);
        const hermesTurnId = metadata?.source === 'hermes' && typeof metadata.turn_id === 'string'
          ? metadata.turn_id
          : null;

        // A rendering this relay asked for and then abandoned — the operator
        // spoke again while it was being created. It is expected, so the call
        // survives; it is superseded, so it is cancelled by id and never
        // becomes `renderingResponseId`. Consumed from the latch so a repeat of
        // the same acknowledgement cannot cancel some later response.
        if (responseId !== null && hermesTurnId !== null
          && this.interruptedRenderTurns.delete(Number(hermesTurnId))) {
          this.send({ type: 'response.cancel', response_id: responseId }, context);
          break;
        }

        const trusted = responseId !== null
          && this.awaitedRenderTurnId !== null
          && hermesTurnId === String(this.awaitedRenderTurnId);

        if (trusted) {
          // One rendering request admits exactly one response; a second one
          // claiming the same turn is no longer expected, and fails closed.
          this.awaitedRenderTurnId = null;
          this.renderingResponseId = responseId;
          break;
        }

        console.warn('[voice] Cancelled an untrusted provider response');
        // Cancel by id when the provider gave a usable one; otherwise the
        // generic cancel, which targets the response currently in progress.
        this.send(responseId === null
          ? { type: 'response.cancel' }
          : { type: 'response.cancel', response_id: responseId }, context);
        this.authority.providerFailure(context, 'provider_response_untrusted');
        break;
      }

      case 'response.done': {
        const response = asRecord(event.response);
        if (typeof response?.id === 'string' && response.id === this.renderingResponseId) {
          this.renderingResponseId = null;
        }
        // Spend is accounted first: a rendering that failed part-way through
        // was still generated, and still billed.
        const usage = parseUsageFromDone(raw);
        if (usage?.reportedCents !== undefined) {
          this.authority.reportSpend(context, usage.reportedCents, 'reported');
        } else if (usage?.audioDurationMs !== undefined && Number.isFinite(this.config.usageUnitPriceCentsPerMinute) && this.config.usageUnitPriceCentsPerMinute > 0) {
          const cents = Math.ceil(usage.audioDurationMs * this.config.usageUnitPriceCentsPerMinute / 60_000);
          if (cents > 0) this.authority.reportSpend(context, cents, 'estimated');
        }
        // A rejected rendering is the operator's question going unanswered with
        // nothing on the surface to say so. Left alone, the call sat on
        // "Listening" indefinitely: the relay had said its piece, the provider
        // had refused it, and no further event was ever coming. Failing the
        // call is what turns that into a state the operator can see and act on.
        if (typeof response?.status === 'string' && FAILED_RESPONSE_STATUSES.includes(response.status)) {
          console.warn('[voice] Provider rejected a rendering response');
          this.failCall(context, 'provider_realtime_error');
        }
        break;
      }

      case 'error': {
        // Provider error bodies can contain request metadata and upstream
        // detail; the log stays coarse and nothing from the body is carried
        // into the failure reason, which is the same generic one every other
        // provider fault uses.
        console.warn('[voice] Provider realtime error event received');
        this.failCall(context, 'provider_realtime_error');
        break;
      }

      default:
        break;
    }
  }

  /**
   * The one and only trigger.
   *
   * A completed input transcription is the first moment the relay knows what
   * the operator actually said, so it is the first moment there is anything to
   * ask Hermes. Everything before it — speech start, audio commit, item
   * creation — is sound, not language.
   */
  private async onFinalTranscript(event: Record<string, unknown>, context: VoiceSessionContext): Promise<void> {
    const itemId = boundedText(event.item_id, VOICE_MAX_ITEM_ID_BYTES);
    if (!itemId) return;
    // The provider may repeat a completed event; one item is one question.
    if (this.handledTranscriptItems.has(itemId)) return;

    const transcript = normalizeVoiceTranscript(event.transcript);
    if (!transcript.ok) {
      console.warn(`[voice] Ignored a transcript that failed validation (${transcript.reason})`);
      return;
    }
    this.rememberTranscriptItem(itemId);

    // Latest speech wins: supersede whatever was outstanding before starting.
    const turn = this.beginTurn(itemId, context);
    this.authority.userTurn(context);

    let result: Awaited<ReturnType<VoiceHermesSpeechSource['send']>>;
    try {
      result = await this.hermes.send(transcript.text, { signal: turn.abort.signal });
    } catch {
      // The client already maps its own failures to a coarse reason; anything
      // thrown past it is treated the same way and never surfaced.
      console.error('[voice] Hermes session chat failed');
      this.finishTurn(turn);
      return;
    }

    // Local invalidation. `pendingTurn` has already moved on if the operator
    // spoke again, and the context/socket may have gone entirely.
    if (!this.isCurrentTurn(turn) || !this.connectedFor(context) || !this.authority.accepts(context)) {
      return;
    }
    this.finishTurn(turn);

    if (result.kind !== 'ok') {
      // No local answer, no canned line, no apology in the assistant's voice.
      // Hermes is the only source of speech; when it fails, nothing is spoken.
      console.warn(`[voice] Hermes turn produced no answer (${result.reason})`);
      return;
    }

    const assistantText = boundedText(result.assistantText, VOICE_HERMES_MAX_ASSISTANT_BYTES);
    if (!assistantText) {
      console.warn('[voice] Hermes answer failed validation and was not spoken');
      return;
    }

    this.renderHermesAnswer(assistantText, turn.id, context);
  }

  /**
   * Speak Hermes' answer, and nothing else.
   *
   * `conversation: 'none'` keeps the rendering out of band, so the audio the
   * provider produces is never fed back to it as context it could build on. The
   * text is supplied as explicit custom input rather than written into the
   * conversation, and the instructions confine the model to reading it.
   */
  private renderHermesAnswer(assistantText: string, turnId: number, context: VoiceSessionContext): void {
    // Recorded before the write: this is the single response the provider is
    // now authorised to start, and the only one `response.created` may match.
    this.awaitedRenderTurnId = turnId;
    this.send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['audio'],
        instructions: VOICE_RENDER_INSTRUCTIONS,
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: assistantText }],
        }],
        // Provenance for cancellation and for the audit trail. Deliberately
        // carries no Hermes session identity — the provider has no business
        // knowing which private session answered.
        metadata: { source: 'hermes', turn_id: String(turnId) },
      },
    }, context);
  }

  /**
   * End whatever this call is currently doing on the operator's behalf.
   *
   * Two things must stop, and stopping only one of them is the bug this exists
   * to prevent: the relay's own fetch to Hermes (aborted here, and locally
   * invalidated so a result that lands anyway is discarded), and any Hermes
   * rendering the provider is still speaking (cancelled by id, so a cancel
   * cannot land on some later response by accident).
   *
   * Aborting the fetch does NOT cancel a run Hermes has already started
   * upstream. The relay can only stop listening for it; it cannot un-ask the
   * question. What it guarantees is narrower and is the part that matters
   * out loud: a superseded answer is never spoken.
   */
  private interruptTurn(context: VoiceSessionContext): void {
    this.abandonPendingTurn();
    // A rendering that was asked for but never acknowledged is no longer
    // authorised. It is latched rather than simply forgotten: its
    // acknowledgement is still in flight and has to be recognised on arrival so
    // it can be cancelled by id instead of being read as an unauthorised
    // response and failing an otherwise healthy call.
    if (this.awaitedRenderTurnId !== null) {
      this.rememberInterruptedRender(this.awaitedRenderTurnId);
      this.awaitedRenderTurnId = null;
    }
    if (this.renderingResponseId) {
      this.send({ type: 'response.cancel', response_id: this.renderingResponseId }, context);
      this.renderingResponseId = null;
    }
  }

  /** Open a new turn, superseding any outstanding one. Monotonic, never reused. */
  private beginTurn(itemId: string, context: VoiceSessionContext): PendingTurn {
    this.interruptTurn(context);
    const turn: PendingTurn = { id: ++this.turnId, itemId, abort: new AbortController() };
    this.pendingTurn = turn;
    return turn;
  }

  private abandonPendingTurn(): void {
    if (!this.pendingTurn) return;
    this.pendingTurn.abort.abort();
    this.pendingTurn = null;
  }

  private isCurrentTurn(turn: PendingTurn): boolean {
    return this.pendingTurn?.id === turn.id && !turn.abort.signal.aborted;
  }

  private finishTurn(turn: PendingTurn): void {
    if (this.pendingTurn?.id === turn.id) this.pendingTurn = null;
  }

  /**
   * End this call on a provider fault, once, with a coarse reason.
   *
   * Every render latch is dropped first so nothing is left half-armed: the
   * session is going away, and a turn id or response id that outlived it could
   * only ever match something belonging to a later call.
   */
  private failCall(context: VoiceSessionContext, reason: string): void {
    this.abandonPendingTurn();
    this.awaitedRenderTurnId = null;
    this.renderingResponseId = null;
    this.interruptedRenderTurns.clear();
    this.authority.providerFailure(context, reason);
  }

  private rememberInterruptedRender(turnId: number): void {
    this.interruptedRenderTurns.add(turnId);
    if (this.interruptedRenderTurns.size > VOICE_MAX_INTERRUPTED_RENDER_MEMORY) {
      const oldest = this.interruptedRenderTurns.values().next().value;
      if (oldest !== undefined) this.interruptedRenderTurns.delete(oldest);
    }
  }

  private rememberTranscriptItem(itemId: string): void {
    this.handledTranscriptItems.add(itemId);
    if (this.handledTranscriptItems.size > VOICE_MAX_TRANSCRIPT_ITEM_MEMORY) {
      const oldest = this.handledTranscriptItems.values().next().value;
      if (oldest !== undefined) this.handledTranscriptItems.delete(oldest);
    }
  }

  private sameContext(a: VoiceSessionContext | null, b: VoiceSessionContext | null): boolean {
    return a?.sessionId === b?.sessionId && a?.epoch === b?.epoch && a?.leaseId === b?.leaseId;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
