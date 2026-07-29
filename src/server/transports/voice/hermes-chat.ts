import { boundedText, isRecord } from './text.js';

/**
 * The private voice surface's ONLY conversational authority.
 *
 * The Realtime model is ears and mouth: it transcribes what the operator said
 * and later reads aloud what Hermes answered. Every word of substance travels
 * this route, server-to-server, over credentials the browser never sees.
 *
 * Supported Hermes interface — exactly one endpoint:
 *
 *   POST {VOICE_HERMES_API_URL}/api/sessions/{session_id}/chat
 *   Authorization: Bearer {VOICE_HERMES_API_KEY}
 *   X-Hermes-Session-Key: {VOICE_HERMES_SESSION_KEY}
 *   { "message": "<the actual transcript>" }
 *
 * Documented response body:
 *
 *   {
 *     "object": "chat.completion",
 *     "session_id": "<effective session id>",
 *     "message": { "content": "<the answer>" },
 *     "usage": { … }
 *   }
 *
 * The authoritative assistant content is `message.content` (a flat `content` is
 * also accepted), and `session_id` is the effective/rotated session id which
 * subsequent turns must follow.
 *
 * DEPLOYMENT REQUIREMENT — the Hermes session-chat API has no per-request tool
 * disable. Voice V1 therefore requires a dedicated/private Hermes API-server
 * deployment whose documented `/v1/toolsets` report has exactly zero effective
 * toolsets. `verifyPolicy()` fetches both `/v1/capabilities` and `/v1/toolsets`
 * over the server-only credential; every unreachable, undeclared or permissive
 * report fails closed. A system prompt asking Hermes not to use tools is not
 * enforcement and is never treated as such.
 */

/** Documented path template. The session id is server state, never request input. */
export const HERMES_CHAT_PATH_TEMPLATE = '/api/sessions/{session_id}/chat';
/** Documented capabilities endpoint used to certify the deployment posture. */
export const HERMES_CAPABILITIES_PATH = '/v1/capabilities';
/** Documented effective API-server toolset endpoint used for the same probe. */
export const HERMES_TOOLSETS_PATH = '/v1/toolsets';
export const HERMES_SESSION_KEY_HEADER = 'X-Hermes-Session-Key';
/** The documented request field carrying the actual transcript. */
export const HERMES_CHAT_MESSAGE_FIELD = 'message';

export const VOICE_HERMES_MAX_TRANSCRIPT_BYTES = 4_000;
export const VOICE_HERMES_MAX_ASSISTANT_BYTES = 4_000;
export const VOICE_HERMES_MAX_SESSION_ID_BYTES = 200;
export const VOICE_HERMES_MAX_RESPONSE_BYTES = 262_144;
export const VOICE_HERMES_REQUEST_TIMEOUT_MS = 30_000;
/** Timeout for the fail-closed deployment-policy probe. */
export const VOICE_HERMES_POLICY_TIMEOUT_MS = 10_000;


/**
 * How many `api_server` toolsets a voice deployment may report: none.
 *
 * This used to tolerate a strictly read-only set for deployments that could not
 * express "none". That tolerance was the enforcement contract's one soft edge —
 * the relay cannot verify what a toolset named `read_only` actually permits, so
 * accepting it meant certifying a capability nobody had checked. A dedicated
 * deployment can express zero, so zero is what is required.
 */
export const HERMES_MAX_API_SERVER_TOOLSETS = 0;

/** Server-only Hermes route. Every field is a secret or a stable server mapping. */
export interface VoiceHermesRoute {
  /** Base URL of the private Hermes API server. HTTPS, or loopback HTTP. */
  readonly apiUrl: string;
  /** Server-only bearer credential. Never returned to a client, never logged. */
  readonly apiKey: string;
  /** Stable session mapping for the authenticated voice account. */
  readonly sessionId: string;
  /** Stable session key header value. Never returned to a client, never logged. */
  readonly sessionKey: string;
  /** Fixed documented capabilities path used for the policy probe. */
  readonly capabilitiesPath: string;
  /** Fixed documented effective toolsets path used for the policy probe. */
  readonly toolsetsPath: string;
  /** Timeout for the policy probe, resolved from VOICE_HERMES_POLICY_TIMEOUT_MS. */
  readonly policyTimeoutMs: number;
}

export type HermesTurnResult =
  | { kind: 'ok'; assistantText: string }
  | { kind: 'error'; reason: string };

export type HermesPolicyResult = { ok: true } | { ok: false; reason: string };

function isPolicyFailure(value: unknown): value is { ok: false; reason: string } {
  return isRecord(value) && value.ok === false && typeof value.reason === 'string';
}

/**
 * The narrow collaborator the transport and bridge depend on.
 *
 * There is deliberately no method through which a caller can name a Hermes
 * session, key or credential: identity is server state resolved from
 * configuration, so a browser cannot select whose history it is talking to.
 */
export interface VoiceHermesAgent {
  send(transcript: string, options: { signal: AbortSignal }): Promise<HermesTurnResult>;
  verifyPolicy(): Promise<HermesPolicyResult>;
}

/** Just the turn-taking half, which is all the Realtime bridge is given. */
export type VoiceHermesSpeechSource = Pick<VoiceHermesAgent, 'send'>;

export interface HermesChatRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

function normalizeBase(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

/** The exact supported session-chat URL for a given session id. */
export function hermesChatUrl(route: VoiceHermesRoute, sessionId: string): string {
  return `${normalizeBase(route.apiUrl)}${HERMES_CHAT_PATH_TEMPLATE.replace('{session_id}', encodeURIComponent(sessionId))}`;
}

/**
 * The explicit request contract, in one place.
 *
 * Kept as a pure helper so a test can assert the URL, headers and body the
 * relay will actually send without standing up a server, and so the transcript
 * cannot quietly become a summary or a placeholder on its way out.
 */
export function buildHermesChatRequest(route: VoiceHermesRoute, sessionId: string, transcript: string): HermesChatRequest {
  return {
    url: hermesChatUrl(route, sessionId),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${route.apiKey}`,
      [HERMES_SESSION_KEY_HEADER]: route.sessionKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ [HERMES_CHAT_MESSAGE_FIELD]: transcript }),
  };
}

/**
 * Validate a final transcript before it is allowed to become a Hermes turn.
 *
 * Over-bound text is refused rather than truncated: half a question answered
 * confidently is worse than a turn that never happened.
 */
export function normalizeVoiceTranscript(value: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof value !== 'string') return { ok: false, reason: 'transcript_not_a_string' };
  const text = value.trim();
  if (text.length === 0) return { ok: false, reason: 'transcript_empty' };
  if (Buffer.byteLength(text, 'utf8') > VOICE_HERMES_MAX_TRANSCRIPT_BYTES) {
    return { ok: false, reason: 'transcript_too_large' };
  }
  return { ok: true, text };
}

export interface HermesChatPayload {
  assistantText: string;
  effectiveSessionId: string | null;
}

/** Parse the documented bounded response shape, or fail closed with a coarse reason. */
export function parseHermesChatResponse(body: unknown): { ok: true; payload: HermesChatPayload } | { ok: false; reason: string } {
  if (!isRecord(body)) return { ok: false, reason: 'hermes_response_not_an_object' };

  const message = isRecord(body.message) ? body.message : null;
  // The documented shape tags the answer with the assistant role. A message that
  // declares some other role is not the assistant's answer — an echoed user
  // turn, a system notice — and speaking it would put words in the operator's
  // ear that Hermes did not answer. An undeclared role is accepted: it is the
  // flat/legacy body, which carries no other role to confuse it with.
  if (message && message.role !== undefined && message.role !== 'assistant') {
    return { ok: false, reason: 'hermes_response_role_not_assistant' };
  }
  const rawContent = typeof body.content === 'string' ? body.content : message?.content;
  const assistantText = boundedText(rawContent, VOICE_HERMES_MAX_ASSISTANT_BYTES);
  if (!assistantText) return { ok: false, reason: 'hermes_response_content_invalid' };

  const rawSessionId = body.session_id ?? body.effective_session_id;
  let effectiveSessionId: string | null = null;
  if (rawSessionId !== undefined && rawSessionId !== null) {
    effectiveSessionId = boundedText(rawSessionId, VOICE_HERMES_MAX_SESSION_ID_BYTES);
    if (!effectiveSessionId) return { ok: false, reason: 'hermes_response_session_id_invalid' };
  }

  return { ok: true, payload: { assistantText, effectiveSessionId } };
}

/**
 * Certify that the Hermes deployment behind this route cannot run tools.
 *
 * The report is deliberately evaluated structurally. Every branch fails closed:
 * an undeclared field is treated exactly like a permissive one, because "the
 * report did not say" is not evidence that tools are off.
 *
 * Every branch fails closed. An undeclared field is treated exactly like a
 * permissive one, because "the configuration did not say" is not evidence that
 * tools are off.
 */
function explicitMcpEnabled(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value.mcp_enabled;
  if (typeof direct === 'boolean') return direct;
  const mcp = value.mcp;
  if (isRecord(mcp) && typeof mcp.enabled === 'boolean') return mcp.enabled;
  const features = value.features;
  if (isRecord(features)) {
    if (typeof features.mcp_enabled === 'boolean') return features.mcp_enabled;
    if (typeof features.mcp === 'boolean') return features.mcp;
  }
  const runtime = value.runtime;
  if (isRecord(runtime)) {
    if (typeof runtime.mcp_enabled === 'boolean') return runtime.mcp_enabled;
    if (isRecord(runtime.mcp) && typeof runtime.mcp.enabled === 'boolean') return runtime.mcp.enabled;
  }
  return undefined;
}

/**
 * Certify the documented `/v1/capabilities` + `/v1/toolsets` responses.
 *
 * `/v1/capabilities` describes the API surface; `/v1/toolsets` is the
 * authoritative resolved `api_server` toolset listing. The latter contains
 * every known toolset, so "effective" means an entry with `enabled: true`, not
 * merely a row in the listing. An explicit MCP-enabled flag, when advertised
 * by a deployment, is also rejected; otherwise the empty effective listing is
 * the documented proof available from this API surface that MCP contributes no
 * tools. Missing or malformed fields fail closed.
 */
export function evaluateHermesToolPolicy(capabilities: unknown, toolsets: unknown): HermesPolicyResult {
  if (!isRecord(capabilities)) return { ok: false, reason: 'hermes_capabilities_undeclared' };
  if (capabilities.object !== 'hermes.api_server.capabilities') {
    return { ok: false, reason: 'hermes_capabilities_shape_invalid' };
  }
  if (capabilities.platform !== 'hermes-agent') {
    return { ok: false, reason: 'hermes_deployment_not_private' };
  }
  const endpoints = capabilities.endpoints;
  if (!isRecord(endpoints)) return { ok: false, reason: 'hermes_capabilities_undeclared' };
  const toolsetsEndpoint = endpoints.toolsets;
  if (!isRecord(toolsetsEndpoint)
    || toolsetsEndpoint.method !== 'GET'
    || toolsetsEndpoint.path !== HERMES_TOOLSETS_PATH) {
    return { ok: false, reason: 'hermes_toolsets_endpoint_undeclared' };
  }

  if (!isRecord(toolsets)
    || toolsets.object !== 'list'
    || toolsets.platform !== 'api_server'
    || !Array.isArray(toolsets.data)) {
    return { ok: false, reason: 'hermes_toolsets_undeclared' };
  }

  let effectiveToolsets = 0;
  for (const entry of toolsets.data) {
    if (!isRecord(entry)
      || typeof entry.name !== 'string'
      || typeof entry.enabled !== 'boolean'
      || !Array.isArray(entry.tools)
      || !entry.tools.every(tool => typeof tool === 'string')) {
      return { ok: false, reason: 'hermes_toolsets_shape_invalid' };
    }
    if (entry.enabled) effectiveToolsets += 1;
  }
  // Exactly none, and nothing else. A named entry is rejected whenever it is
  // effective, whatever it is called: `read_only` is a label the relay cannot
  // verify. This also rejects effective MCP toolsets.
  if (effectiveToolsets !== HERMES_MAX_API_SERVER_TOOLSETS) {
    return { ok: false, reason: 'hermes_api_server_toolsets_not_empty' };
  }

  const mcpEnabled = explicitMcpEnabled(capabilities) ?? explicitMcpEnabled(toolsets);
  if (mcpEnabled === true) return { ok: false, reason: 'hermes_mcp_not_disabled' };

  return { ok: true };
}

/**
 * Resolve configuration into a usable route, or say why it cannot be used.
 *
 * Reasons name env vars only — never their values — because this string reaches
 * startup logs.
 */
export function resolveVoiceHermesRoute(raw: Partial<VoiceHermesRoute> | undefined): { ok: true; route: VoiceHermesRoute } | { ok: false; reason: string } {
  const apiUrl = (raw?.apiUrl ?? '').trim();
  const apiKey = (raw?.apiKey ?? '').trim();
  const sessionId = (raw?.sessionId ?? '').trim();
  const sessionKey = (raw?.sessionKey ?? '').trim();
  const capabilitiesPath = (raw?.capabilitiesPath ?? HERMES_CAPABILITIES_PATH).trim();
  const toolsetsPath = (raw?.toolsetsPath ?? HERMES_TOOLSETS_PATH).trim();
  const policyTimeoutMs = raw?.policyTimeoutMs ?? VOICE_HERMES_POLICY_TIMEOUT_MS;

  if (!apiUrl) return { ok: false, reason: 'VOICE_HERMES_API_URL is not configured' };
  if (!apiKey) return { ok: false, reason: 'VOICE_HERMES_API_KEY is not configured' };
  if (!sessionId) return { ok: false, reason: 'VOICE_HERMES_SESSION_ID is not configured' };
  if (!sessionKey) return { ok: false, reason: 'VOICE_HERMES_SESSION_KEY is not configured' };
  if (capabilitiesPath !== HERMES_CAPABILITIES_PATH) return { ok: false, reason: 'HERMES_CAPABILITIES_PATH is invalid' };
  if (toolsetsPath !== HERMES_TOOLSETS_PATH) return { ok: false, reason: 'HERMES_TOOLSETS_PATH is invalid' };
  if (!Number.isSafeInteger(policyTimeoutMs) || policyTimeoutMs < 100 || policyTimeoutMs > 120_000) {
    return { ok: false, reason: 'VOICE_HERMES_POLICY_TIMEOUT_MS is invalid' };
  }
  if (Buffer.byteLength(sessionId, 'utf8') > VOICE_HERMES_MAX_SESSION_ID_BYTES) {
    return { ok: false, reason: 'VOICE_HERMES_SESSION_ID is longer than the supported bound' };
  }

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return { ok: false, reason: 'VOICE_HERMES_API_URL is not a valid URL' };
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    return { ok: false, reason: 'VOICE_HERMES_API_URL must use HTTPS, or HTTP on loopback' };
  }

  return { ok: true, route: { apiUrl, apiKey, sessionId, sessionKey, capabilitiesPath, toolsetsPath, policyTimeoutMs } };
}

/** Startup tripwire. Voice must not come up at all against an unusable route. */
export function assertVoiceHermesRoute(raw: Partial<VoiceHermesRoute> | undefined): VoiceHermesRoute {
  const resolved = resolveVoiceHermesRoute(raw);
  if (!resolved.ok) {
    throw new Error(
      `${resolved.reason}. Voice V1 speaks only what the private Hermes deployment answers, `
      + 'so it refuses to start without a complete server-only Hermes route.'
    );
  }
  return resolved.route;
}

export interface HermesSessionChatClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Server-only Hermes session-chat client.
 *
 * Holds the effective session id in server state. Nothing a browser sends can
 * reach it: `send()` takes a transcript and an abort signal, and that is the
 * whole input surface.
 */
export class HermesSessionChatClient implements VoiceHermesAgent {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private effectiveSessionId: string;
  /**
   * Monotonic per-request generation, claimed before any I/O.
   *
   * Turns overlap: barge-in abandons a fetch without un-asking the question, so
   * a superseded request can still complete — and complete *after* the request
   * that replaced it. The session mapping used to be written by whichever reply
   * landed last, which meant a stale turn could roll the effective session id
   * back onto an id the newer turn had already moved off. The generation is
   * what makes "is this reply still the authority" answerable.
   */
  private generation = 0;

  constructor(private readonly route: VoiceHermesRoute, options: HermesSessionChatClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? VOICE_HERMES_REQUEST_TIMEOUT_MS;
    this.effectiveSessionId = route.sessionId;
  }

  /** The session mapping currently in force. Read-only; there is no setter. */
  get sessionId(): string {
    return this.effectiveSessionId;
  }

  async send(transcript: string, options: { signal: AbortSignal }): Promise<HermesTurnResult> {
    const validated = normalizeVoiceTranscript(transcript);
    if (!validated.ok) return { kind: 'error', reason: validated.reason };

    // Claimed before the request is even built, so the ordering that decides
    // authority is the ordering in which turns were *started*, not the
    // ordering in which the network happened to answer.
    const generation = ++this.generation;
    const request = buildHermesChatRequest(this.route, this.effectiveSessionId, validated.text);
    // The caller's turn signal plus a hard request timeout. Aborting the turn
    // aborts this fetch; it cannot cancel a run already started upstream.
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]);

    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        cache: 'no-store',
        signal,
      });
    } catch {
      // Upstream error text can echo the credential that was sent; it is never
      // surfaced, only counted.
      return { kind: 'error', reason: options.signal.aborted ? 'hermes_turn_aborted' : 'hermes_unreachable' };
    }

    if (!response.ok) return { kind: 'error', reason: `hermes_http_${response.status}` };

    const body = await this.readBoundedJson(response);
    if (body === undefined) return { kind: 'error', reason: 'hermes_response_unreadable' };

    const parsed = parseHermesChatResponse(body);
    if (!parsed.ok) return { kind: 'error', reason: parsed.reason };

    // A server-chosen effective/rotated id governs subsequent turns — but only
    // when this turn is still the authority. Everything that could make the
    // reply unusable (transport failure, HTTP status, oversize body, malformed
    // JSON, an invalid id) has already returned above, so the mapping is only
    // ever moved by a reply that fully validated.
    if (parsed.payload.effectiveSessionId && generation === this.generation) {
      this.effectiveSessionId = parsed.payload.effectiveSessionId;
    }
    return { kind: 'ok', assistantText: parsed.payload.assistantText };
  }

  /** Fetch and certify the deployment's tool posture over server-only auth. */
  async verifyPolicy(): Promise<HermesPolicyResult> {
    const fetchPolicyDocument = async (path: string, label: 'capabilities' | 'toolsets'): Promise<unknown | HermesPolicyResult> => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${normalizeBase(this.route.apiUrl)}${path}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.route.apiKey}`,
            Accept: 'application/json',
          },
          cache: 'no-store',
          signal: AbortSignal.timeout(this.route.policyTimeoutMs),
        });
      } catch {
        return { ok: false, reason: `hermes_${label}_unreachable` };
      }
      if (!response.ok) return { ok: false, reason: `hermes_${label}_http_${response.status}` };
      const body = await this.readBoundedJson(response);
      if (body === undefined) return { ok: false, reason: `hermes_${label}_unreadable` };
      return body;
    };

    const capabilities = await fetchPolicyDocument(this.route.capabilitiesPath, 'capabilities');
    if (isPolicyFailure(capabilities)) return capabilities;
    const toolsets = await fetchPolicyDocument(this.route.toolsetsPath, 'toolsets');
    if (isPolicyFailure(toolsets)) return toolsets;
    return evaluateHermesToolPolicy(capabilities, toolsets);
  }

  /** Read a bounded body and parse it. `undefined` means unusable. */
  private async readBoundedJson(response: Response): Promise<unknown> {
    const text = await this.readBoundedText(response);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * Read a response body under a byte ceiling, enforced *while it streams*.
   *
   * `response.text()` buffers the whole body first and only then permits a size
   * check, so the check could only ever report a limit that had already been
   * exceeded — a deployment that answered with a gigabyte would have made the
   * relay hold a gigabyte before refusing it. The ceiling has to be applied to
   * the bytes as they arrive: the moment the running total passes it the reader
   * is cancelled, the rest of the body is never pulled, and the turn fails
   * closed. `undefined` means unusable.
   */
  private async readBoundedText(response: Response): Promise<string | undefined> {
    const body = response.body;
    if (!body) {
      // No stream to bound — an empty body, or a double that supplied none.
      try {
        const text = await response.text();
        return Buffer.byteLength(text, 'utf8') > VOICE_HERMES_MAX_RESPONSE_BYTES ? undefined : text;
      } catch {
        return undefined;
      }
    }

    const reader = body.getReader();
    const cancel = async (): Promise<void> => { await reader.cancel().catch(() => { /* already gone */ }); };
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > VOICE_HERMES_MAX_RESPONSE_BYTES) {
          await cancel();
          return undefined;
        }
        chunks.push(Buffer.from(value));
      }
    } catch {
      await cancel();
      return undefined;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
