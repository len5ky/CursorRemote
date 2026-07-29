/**
 * Origin policy for the private voice surface.
 *
 * The documented deployment is Tailscale Serve terminating TLS and forwarding
 * to loopback HTTP (`tailscale serve --https=443 http://127.0.0.1:3000`). The
 * relay therefore sees `http://` on a loopback socket while the browser sends
 * `Origin: https://<machine>.<tailnet>.ts.net`. Reconstructing the expected
 * origin from `req.protocol` + `Host` is wrong for that deployment, and every
 * input it would need — `Host`, `X-Forwarded-Proto`, `X-Forwarded-Host` — is
 * attacker-controlled on a direct request to the loopback port.
 *
 * So the canonical public origin is explicit, validated server configuration
 * (`VOICE_PUBLIC_ORIGIN`), never inferred from a request header. Nothing in
 * this module reads a request.
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Validate an operator-supplied origin and return its canonical serialization.
 *
 * Accepts only a bare `https://host[:port]` origin, or `http://` on a loopback
 * host for local development. Throws on anything else — a misconfigured origin
 * is a startup failure, not a silently widened allow set.
 */
export function normalizeVoiceOrigin(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) throw new Error('voice public origin must not be empty');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`voice public origin must be an absolute origin (got "${value}")`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`voice public origin must use https (got "${value}")`);
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      `voice public origin must use https on a routable host; http is only allowed on loopback (got "${value}")`
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('voice public origin must not carry credentials');
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new Error(`voice public origin must not carry a path (got "${value}")`);
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`voice public origin must not carry a query or fragment (got "${value}")`);
  }
  if (url.origin === 'null') {
    throw new Error(`voice public origin must be a real origin (got "${value}")`);
  }
  return url.origin;
}

export interface VoiceOriginPolicyOptions {
  /** `VOICE_PUBLIC_ORIGIN`. Empty means "loopback development only". */
  publicOrigin: string;
  /** Loopback port the relay is bound to, used for the development allow set. */
  serverPort: number;
}

export interface VoiceOriginPolicy {
  /** Every origin this policy accepts, for logging and diagnostics. */
  readonly allowed: readonly string[];
  /**
   * `undefined` means the request carried no `Origin` header (a non-browser
   * caller or a same-origin navigation) and is allowed. A repeated `Origin`
   * header arrives as an array and is always refused.
   */
  allows(origin: string | string[] | undefined): boolean;
}

export function createVoiceOriginPolicy(options: VoiceOriginPolicyOptions): VoiceOriginPolicy {
  const allowed = new Set<string>();

  const configured = options.publicOrigin.trim();
  if (configured.length > 0) allowed.add(normalizeVoiceOrigin(configured));

  // Local development against the loopback bind. These are the only origins
  // that are ever implicit, and they are unreachable from off-host because the
  // relay binds loopback.
  if (Number.isInteger(options.serverPort) && options.serverPort > 0) {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      allowed.add(`http://${host}:${options.serverPort}`);
    }
  }

  const frozen = Object.freeze([...allowed]);
  return {
    allowed: frozen,
    allows(origin: string | string[] | undefined): boolean {
      if (origin === undefined) return true;
      if (Array.isArray(origin)) return false;
      const value = origin.trim();
      if (value.length === 0) return false;
      return allowed.has(value);
    },
  };
}
