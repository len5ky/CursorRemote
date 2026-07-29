import { createHash } from 'node:crypto';

/**
 * Who a login attempt should be rate-limited *as*.
 *
 * The documented deployment is `tailscale serve --https=443
 * http://127.0.0.1:3000`, so every request the relay sees arrives from
 * 127.0.0.1. Keying the login limiter on the peer address therefore collapses
 * the entire tailnet into a single bucket: ten fat-fingered attempts by one
 * operator lock out every other device on the tailnet, which is a
 * denial-of-service dressed up as a security control.
 *
 * The fix is *not* "trust a forwarded header". On a direct request to the
 * loopback port every header is whatever the caller typed, so a limiter keyed
 * off one is no limiter at all — the caller simply rotates it.
 *
 * The trust boundary here is therefore narrow and has two halves, both of which
 * must hold before any header is believed:
 *
 *  1. **The operator declares it.** `TAILSCALE_SERVE_IDENTITY=true` is an
 *     explicit statement that this relay is published through Tailscale Serve
 *     and is not reachable any other way. Without it the header is not read at
 *     all, so a default deployment cannot be talked into believing one.
 *  2. **The request arrives on loopback.** That is where, and only where, the
 *     Serve proxy connects from. Serve overwrites its own `Tailscale-User-*`
 *     headers on every forwarded request, so a tailnet client cannot inject a
 *     chosen value through it. A caller reaching the port from anywhere else is
 *     not coming through Serve, so its headers mean nothing and are ignored.
 *
 * The resulting key is a hash. The raw login is a person's identity and has no
 * business in a rate-limit table, a log line or a response.
 */

/** Lower-cased, because `http.IncomingMessage.headers` keys are lower-cased. */
export const TAILSCALE_IDENTITY_HEADER = 'tailscale-user-login';

/** Printable ASCII, no spaces. Bounded so a hostile header cannot be a payload. */
const IDENTITY_PATTERN = /^[\x21-\x7e]{1,256}$/;

export interface LoginIdentityInput {
  /** The real socket peer. Never a header-derived value. */
  remoteAddress: string | undefined;
  headers: NodeJS.Dict<string | string[]>;
  /** `TAILSCALE_SERVE_IDENTITY` — the operator's declaration, see above. */
  trustTailscaleIdentity: boolean;
}

export interface LoginIdentity {
  /** Opaque bucket key. Safe to hold in memory; never carries the raw identity. */
  key: string;
  source: 'tailscale-identity' | 'peer-address';
}

/**
 * Normalize an IPv4-mapped IPv6 peer (`::ffff:127.0.0.1`) and a scoped IPv6
 * loopback (`::1%lo0`) down to the address Node would otherwise report
 * inconsistently across binds.
 */
function normalizeAddress(address: string): string {
  const withoutScope = address.split('%')[0];
  return withoutScope.startsWith('::ffff:') ? withoutScope.slice(7) : withoutScope;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== 'string' || address.length === 0) return false;
  const normalized = normalizeAddress(address);
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.');
}

/**
 * A single, well-formed header value, or `null`.
 *
 * Node surfaces a repeated header either as an array or joined with `", "`, and
 * neither is one verified login — a caller that could append a second value
 * could otherwise pick a bucket by smuggling a comma past a Serve-set header.
 * There is no trimming: a value that needs trimming did not come from Serve.
 */
function singleIdentityHeader(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.includes(',')) return null;
  return IDENTITY_PATTERN.test(raw) ? raw : null;
}

export function resolveLoginIdentity(input: LoginIdentityInput): LoginIdentity {
  const peer = typeof input.remoteAddress === 'string' && input.remoteAddress.length > 0
    ? normalizeAddress(input.remoteAddress)
    : 'unknown';

  if (input.trustTailscaleIdentity && isLoopbackAddress(input.remoteAddress)) {
    const identity = singleIdentityHeader(input.headers[TAILSCALE_IDENTITY_HEADER]);
    if (identity !== null) {
      return {
        key: `tsid:${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`,
        source: 'tailscale-identity',
      };
    }
  }

  return { key: `peer:${peer}`, source: 'peer-address' };
}
