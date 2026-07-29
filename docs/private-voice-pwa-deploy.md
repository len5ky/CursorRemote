# Private voice PWA — deployment and privacy guide

Operator guide for the private read-only voice surface: a one-page installable
web app that places a voice call to your own Hermes context and can only *read*
it.

This document contains **no credentials**. Every secret is referred to by
environment-variable name only.

---

## 1. What this is, and what it is not

**Is:**

- A single-user, private voice companion for one authenticated operator.
- Read-only: it can describe sessions, status and recent conversation, and end
  its own call. Nothing else.
- Browser ⇄ OpenAI Realtime audio over WebRTC, pinned to `gpt-realtime-2.1`.
- **Browser PWA only.** The supported surface is the installable page at
  `/voice`, served by this relay and opened in Safari (iOS) or Chrome
  (Android/desktop). There is no supported native client: the archived Android
  app in `apps/dicktator-android` targets the removed mutation-capable contract
  and is not built, tested or shipped. See
  [`dicktator.md § What changed`](./dicktator.md#what-changed).

**Is not** (explicit non-goals):

- No PSTN, SIP, Twilio, phone numbers, or inbound calls.
- No public internet deployment.
- No multi-user tenancy or shared calls.
- No voice approval, rejection, message sending, or command execution.
- No offline calling, background sync, or push notifications.
- No audio recording or transcript archive.
- No alternate, preview, mini or fallback Realtime model.

---

## 2. Data flow and privacy

```
Phone PWA ──HTTPS (Tailscale)──> relay        POST /api/voice/token
   │                               │            mints a short-lived ephemeral credential
   │                               │            + sessionId, epoch, one-time attachToken
   │
   ├──WebRTC audio──────────────> OpenAI Realtime (gpt-realtime-2.1)
   │                               ▲
   └──HTTPS──> relay ──sideband WS─┘   server-held standard key, tool calls only
                  │
                  └─> HermesConversationReader (read-only, bounded, redacted)
```

Be clear with yourself about what this means:

- **Your audio goes to OpenAI.** "Private relay" means the relay is not exposed
  to the internet — it does **not** mean the conversation avoids OpenAI.
- The relay never receives or records audio. Audio is browser ⇄ OpenAI only.
- Bounded, redacted Hermes text context and tool responses **are** sent to
  OpenAI through the Realtime session.
- Nothing persists audio, SDP, provider event bodies, ephemeral credentials or
  transcripts. Only coarse lifecycle metadata and the cost/session ledger are
  written to disk.
- Speech in the call is never written back into Hermes.

---

## 3. Network: Tailscale + HTTPS (required)

Microphone access requires a **secure context**. Plain HTTP over a LAN or a bare
tailnet IP will not grant the microphone on mobile, so `https://` is mandatory
for this surface. (The legacy non-voice web client in
[`tailscale-setup.md`](./tailscale-setup.md) can run over plain HTTP; the voice
page cannot.)

### 3.1 Bind the relay to loopback

```bash
SERVER_HOST=127.0.0.1
SERVER_PORT=3000
```

Do not bind `0.0.0.0`. Do not port-forward. Do not open a firewall rule.

### 3.2 Publish it with Tailscale Serve

Enable MagicDNS and HTTPS certificates for the tailnet once, in the Tailscale
admin console (**DNS → MagicDNS**, **DNS → HTTPS Certificates**). Then, on the
machine running the relay:

```bash
# 1. Confirm the tailnet name this node answers to. The output is the host part
#    of your canonical origin, e.g. workstation.tailnet-1234.ts.net
tailscale status --json | grep -i dnsname

# 2. Publish loopback:3000 as HTTPS/443 on that name. This is the whole config:
#    TLS terminates at Tailscale, and the relay only ever sees loopback HTTP.
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000

# 3. Verify the mapping and that nothing is exposed publicly
tailscale serve status          # expect: https://<machine>.<tailnet>.ts.net → http://127.0.0.1:3000
tailscale funnel status         # expect: no Funnel configured
```

Use `tailscale serve`, **not** `tailscale funnel` — Funnel publishes to the
public internet, which is an explicit non-goal here.

To tear it down: `sudo tailscale serve --https=443 off`.

### 3.3 Tell the relay its public origin

Tailscale Serve terminates TLS and forwards plain HTTP to loopback, so the relay
sees `http://` on a loopback socket while the browser sends
`Origin: https://<machine>.<tailnet>.ts.net`. The expected origin therefore
cannot be reconstructed from the request — `Host`, `X-Forwarded-Proto` and
`X-Forwarded-Host` are all attacker-controlled on a direct request to the
loopback port — so it is explicit, validated configuration:

```bash
VOICE_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net    # exactly the origin the browser sends
```

Rules the value must satisfy, or the server refuses to start:

- Scheme + host (+ port) only. No trailing path, no query, no fragment, no
  embedded credentials.
- `https://` on any routable host. `http://` is accepted only on `127.0.0.1`,
  `localhost` or `[::1]`, for local development.

If it is unset, the only accepted origins are
`http://127.0.0.1:<SERVER_PORT>`, `http://localhost:<SERVER_PORT>` and
`http://[::1]:<SERVER_PORT>` — the relay starts with a warning and every request
from the phone is refused with `403 Origin denied`.

### 3.4 Optional: bucket the login limiter by verified Tailscale identity

Tailscale Serve terminates TLS and forwards to loopback, so **every** request
the relay sees arrives from `127.0.0.1`. A login rate limiter keyed on the peer
address is therefore one bucket for the entire tailnet: ten fat-fingered
attempts from one device lock out every other device you own.

`TAILSCALE_SERVE_IDENTITY=true` splits that bucket per verified Tailscale user.

```bash
TAILSCALE_SERVE_IDENTITY=true     # ONLY on a Serve-published, loopback-bound relay
```

**The trust boundary, exactly.** Serve injects `Tailscale-User-Login` (and the
other `Tailscale-User-*` headers) describing the tailnet identity it
authenticated, and it *overwrites* any copy the client sent — a tailnet client
cannot choose what Serve forwards. That header is believed only when **both** of
these hold:

1. **You declared it.** With `TAILSCALE_SERVE_IDENTITY` unset (the default) the
   header is not read at all, so a relay on any other topology cannot be talked
   into believing one. This matters because on a direct request to the loopback
   port every header is simply whatever the caller typed — a limiter keyed off
   an undeclared forwarded header is no limiter, since the caller just rotates
   it to mint fresh buckets.
2. **The request arrived on loopback.** That is where, and only where, the Serve
   proxy connects from. A caller reaching the port from anywhere else did not
   come through Serve, so its headers are ignored and it is bucketed by peer
   address.

A value that is not a single, printable, bounded, comma-free token — including a
repeated header, which Node presents joined with `", "` — is not a verified
login and falls back to the peer bucket rather than selecting one of its own.

The identity is hashed before it is used as a bucket key. It is never logged,
never returned in a response, and never stored.

**A global login guard applies regardless**, above the per-identity buckets, so
churning identities cannot buy an unlimited number of password guesses. Do not
set `TAILSCALE_SERVE_IDENTITY=true` on a relay reachable any other way: the
correct configuration is loopback bind + Serve, per § 3.1 and § 3.2.

### 3.5 Install to the home screen

Open `/voice` in Safari (iOS) or Chrome (Android) and use *Add to Home Screen*.
The app is installable and online-only; the service worker is network-only and
caches nothing.

---

## 4. Application authentication (mandatory)

Tailscale is defence in depth, not the authentication layer.

`WEBAPP_PASSWORD` is **required** whenever `VOICE_ENABLED=true`. It is not an
option:

- With `VOICE_ENABLED=true` and no `WEBAPP_PASSWORD`, `loadConfig()` throws and
  the server **refuses to start**.
- If a relay is somehow constructed in that state anyway, every `/api/voice/*`
  route and the `/voice` page answer `503` and log once, rather than serving an
  unauthenticated voice surface to the tailnet.

```bash
WEBAPP_PASSWORD=<set-a-strong-value>     # value not shown here
```

With it set:

- `/voice`, `/voice.html`, `/voice.js` and `/voice.css` require an authenticated
  session and redirect to `/login?next=%2Fvoice` otherwise — back into the
  installed PWA scope, not out to the remote-control root. Only `/voice` and
  `/voice.html` are accepted as return targets; anything else falls back to `/`.
- That check is made on the **normalized** request path, before the static file
  mount ever sees it, so `//voice.js`, `/./voice.js`, `/a/../voice.js` and
  `/voice%2Ejs` are all the same guarded asset rather than an unguarded one.
- Every `/api/voice/*` endpoint requires the session and is rate-limited.
- Requests with a foreign `Origin` are rejected, and the socket.io CORS allow
  set is the same validated origin list — never a reflection of whatever the
  caller sent.
- All voice responses are sent `Cache-Control: no-store`, with the voice CSP,
  `Permissions-Policy`, `Referrer-Policy` and `X-Content-Type-Options`.

The manifest, service worker and icons stay public — they contain no secrets and
installability should work before login.

Persisted login sessions (`DATA_DIR/webapp-sessions.json`) are bearer
credentials and are written mode `0600` through an atomic temp-file rename, so a
file created by an older build is tightened on the next write.

---

## 5. Environment variables

Names only. Never commit values; keep them in your secret store.

### Required

| Variable | Purpose |
| --- | --- |
| `VOICE_ENABLED` | Set `true` to enable the voice transport. |
| `OPENAI_API_KEY` | **Server-only** standard key. Mints ephemeral credentials and opens the sideband. Never sent to the browser, never logged. |
| `WEBAPP_PASSWORD` | Relay authentication. **Mandatory** with `VOICE_ENABLED=true`; startup fails without it (§ 4). |
| `VOICE_PUBLIC_ORIGIN` | Canonical browser origin, e.g. `https://<machine>.<tailnet>.ts.net`. **Required for any non-loopback deployment** (§ 3.3). Never inferred from a request header; a malformed value fails startup. |
| `SERVER_HOST` / `SERVER_PORT` | Loopback bind for the relay. `SERVER_PORT` also defines the implicit loopback development origins. |
| `DATA_DIR` | Directory holding `voice-usage.json`, the cost/session ledger, and `webapp-sessions.json`, the login session store — both mode `0600`. No audio, transcript, SDP, provider event body or provider credential is written there. |

### Optional network identity

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAILSCALE_SERVE_IDENTITY` | `false` | Declares that this relay is published *only* through Tailscale Serve, letting the login rate limiter bucket per verified Tailscale user instead of collapsing the tailnet into one loopback bucket. Serve's `Tailscale-User-*` headers are read only when this is `true` **and** the request arrives from loopback. A global login guard applies either way. Full trust boundary: § 3.4. |

### Hermes context (read-only)

| Variable | Purpose |
| --- | --- |
| `HERMES_READ_CONTEXT_URL` | Documented read-only Hermes endpoint. Must be HTTPS, or loopback HTTP. **If unset, voice reports context unavailable** — it never invents conversation content. |
| `HERMES_READ_CONTEXT_TOKEN` | Optional server-only bearer for that endpoint. Never returned or logged. |

### Model

There is **no model variable to configure.** Every Realtime session is pinned to
`gpt-realtime-2.1` by `VOICE_REALTIME_MODEL` in
`src/server/transports/voice/constants.ts`.

`VOICE_MODEL` survives only as a tripwire: if it is set to anything other than
`gpt-realtime-2.1`, the server **refuses to start**. There is no mini model, no
preview model, no automatic fallback and no retry against another model.

### Caps and lifecycle

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOICE_NAME` | `marin` | Realtime output voice. |
| `VOICE_ACCOUNT_ID` | `default-operator` | Stable single-operator budget account (§ 5.1). |
| `VOICE_USAGE_PRICE_VERSION` | `openai-realtime-2026-01` | Must name an entry in the frozen price table (§ 5.2). |
| `VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE` | table reference rate (`50`) | Conservative local estimate. Raise it to be more conservative. |
| `VOICE_USAGE_DAILY_CAP_CENTS` | `500` | Hard daily cap per account. |
| `VOICE_USAGE_PER_SESSION_CAP_CENTS` | `100` | Per-session reservation and hard cap. Must not exceed the daily cap. |
| `VOICE_SESSION_ABSOLUTE_MS` | `1800000` | Absolute wall-clock session cap. |
| `VOICE_SESSION_IDLE_MS` | `120000` | Idle termination bound. |
| `VOICE_SESSION_IDLE_GRACE_MS` | `60000` | Grace window before reaping an idle session. |
| `VOICE_SESSION_LEASE_MS` | `30000` | Heartbeat lease length. |

Heartbeats keep the lease alive but deliberately do **not** refresh user
idleness, so an unattended open tab still gets reaped.

Every numeric variable above is validated at startup: it must be a plain decimal
integer inside its declared range. `parseInt('abc', 10)` is `NaN`, and a `NaN`
cap compares false against everything — i.e. silently disables the brake it was
meant to be. A bad value is a boot failure instead.

There is deliberately **no** context-freshness variable. The Hermes read
contract reports each snapshot's `observedAt`, but nothing in V1 gates a tool
answer on that timestamp, so advertising a maximum age would be describing a
control that does not exist.

### 5.1 Budget account identity

The cost ledger is keyed to `VOICE_ACCOUNT_ID`, **not** to a login session.

A web session token is ephemeral: keying the daily cap on one meant that logging
out and back in produced a new token, which hashed to a brand-new ledger
account, which came with a brand-new daily cap. The cap was one login away from
being unlimited.

`VOICE_ACCOUNT_ID` is 1–64 characters from `[A-Za-z0-9._@-]` and defaults to
`default-operator`. It is not a secret — but it is never returned in any
response, never logged, and reaches both the ledger and the provider's
`safety_identifier` only as a SHA-256 hash. Authorization is unaffected: who may
act on a live session is still the authenticated web session, so one operator
can never see or end another's call.

### 5.2 Price versions

`VOICE_USAGE_PRICE_VERSION` must name an entry in `VOICE_PRICE_TABLE`
(`src/server/transports/voice/pricing.ts`), which is frozen at build time:

| Version | Reference rate | Covers |
| --- | --- | --- |
| `openai-realtime-2026-01` | 50 ¢/min | OpenAI Realtime audio, January 2026 published rate card |

An unknown version fails startup, and is refused a second time at admission, so
a paid call is never metered and settled against a rate card nobody reviewed.
Adding a version is a reviewed code change — matching exactly, not
case-insensitively and not by prefix, because a price version is an identifier
rather than a search term.

The table's reference rate is the default for the *local* estimate used before
the provider reports actual usage; `VOICE_USAGE_UNIT_PRICE_CENTS_PER_MINUTE`
overrides it.

### 5.3 What "usage" means

Provider `response.done` usage is **per response**, not a running total for the
call. Each reported response cost is therefore *added* to the session total —
a call that costs 30¢ then 40¢ has spent 70¢, not 40¢ — and the same applies to
costs priced locally from audio duration when the provider reports no cents.

Where the provider reports nothing at all, a conservative wall-clock estimate at
the configured unit price stands in. Settlement writes
`max(wall-clock estimate, accumulated per-response costs)` to the durable daily
ledger, capped at the per-session reservation, so the number that survives a
restart can never be lower than the one the live budget brake was already
enforcing.

### Bounds that are not configurable

These are compile-time constants in
`src/server/transports/voice/constants.ts`, deliberately not environment
variables, and every one of them is a **UTF-8 byte** bound:

| Constant | Value | Bounds |
| --- | --- | --- |
| `VOICE_MAX_TOOL_ARGUMENT_BYTES` | 8192 | Realtime function-call argument blob. Larger blobs are refused, not parsed. |
| `VOICE_MAX_TOOL_OUTPUT_BYTES` | 2000 | Tool answer returned to the model. |
| `VOICE_MAX_CONTEXT_BYTES` | 12000 | Serialized Hermes snapshot. Turns, then sessions, are dropped to fit; a snapshot that cannot fit is reported unavailable rather than sent over budget. |
| `VOICE_MAX_CONTEXT_TURNS` | 12 | Conversation turns per read. |
| `VOICE_MAX_PROVIDER_EVENT_BYTES` | 32768 | Provider sideband event the relay will parse. Oversize events are dropped without ending the call. |

---

## 6. Credential handling

**Standard key (`OPENAI_API_KEY`)**

- Server environment or secret manager only.
- Used for minting ephemeral credentials and for the sideband WebSocket.
- Never included in client assets, API responses, logs or error bodies.

**Ephemeral browser credential**

- Returned once to the authenticated browser.
- Memory-only for the duration of WebRTC negotiation, then dropped.
- Never logged, never persisted, never written to `localStorage` /
  `sessionStorage`, never placed in a URL, never cached by the service worker.
- Sent only to OpenAI during WebRTC setup.

**Attach token**

- Short-lived, single-use, bound to the authenticated owner, `sessionId` and
  `epoch`. Consumed before any provider I/O, so a replay cannot attach a second
  sideband.

**Rotation**

Rotate `OPENAI_API_KEY` at your provider, update the environment, restart the
relay. In-flight calls end at their next lease expiry. Rotating
`WEBAPP_PASSWORD` invalidates future logins; existing session cookies are
cleared by restarting with a new data directory if you need a hard reset.

---

## 7. Running

```bash
# Secrets come from your own store; values are never printed.
# The file supplies OPENAI_API_KEY and WEBAPP_PASSWORD, and optionally
# HERMES_READ_CONTEXT_URL / HERMES_READ_CONTEXT_TOKEN.
set -a; source <your-secret-env-file>; set +a

VOICE_ENABLED=true \
SERVER_HOST=127.0.0.1 \
SERVER_PORT=3000 \
VOICE_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net \
npm run build && npm start
```

Startup refuses to proceed if `WEBAPP_PASSWORD` is missing, if `VOICE_MODEL` is
set to anything but `gpt-realtime-2.1`, or if `VOICE_PUBLIC_ORIGIN` is
malformed. It warns — and then accepts loopback origins only — if
`VOICE_PUBLIC_ORIGIN` is absent.

Then from the phone, on the tailnet:

```
https://<machine>.<tailnet>.ts.net/voice
```

Tap **Call**, grant the microphone, and speak. Tap **Hang up** to end.

### Health

`GET /api/voice/status` (authenticated) reports connection, session id, epoch,
state, idle status, context availability, component health, and budget. It never
returns a credential.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Button does nothing; state stays `Ready` | Page not served over HTTPS | Use `tailscale serve` and open the `https://…ts.net` URL, not an IP. |
| `Microphone permission is required` | Permission denied, or insecure context | Grant the mic in site settings; confirm the padlock. |
| Redirected to `/login` | No authenticated session | Log in with `WEBAPP_PASSWORD`. |
| `403 Origin denied` on every `/api/voice/*` call from the phone | `VOICE_PUBLIC_ORIGIN` unset, or not byte-for-byte the origin the browser sends | Set it to exactly the scheme + host (+ port) shown in `tailscale serve status`, with no trailing slash or path, and restart. Startup logs a warning when it is unset. Serving on a non-default port means the port is part of the origin. |
| Server refuses to start, complains about the voice public origin | `VOICE_PUBLIC_ORIGIN` carries a path, query, fragment, credentials, or is `http://` on a routable host | Reduce it to a bare `https://host[:port]` origin (§ 3.3). |
| Server refuses to start, complains about `WEBAPP_PASSWORD` | `VOICE_ENABLED=true` with no password | Set `WEBAPP_PASSWORD`, or disable voice (§ 4). |
| `503 Voice is unavailable.` from every voice route | Voice enabled without authentication configured | Same fix as above; the relay refuses to serve voice unauthenticated. |
| `Could not start a call right now.` | Token mint failed | Check `OPENAI_API_KEY` is set server-side and the provider is reachable. |
| Voice says live context is unavailable | `HERMES_READ_CONTEXT_URL` unset or unreachable | Configure the documented read endpoint. This is intentional — it will never invent content. |
| Server refuses to start, complains about `VOICE_MODEL` | `VOICE_MODEL` set to a non-pinned model | Unset it, or set it to exactly `gpt-realtime-2.1`. |
| Call ends by itself | Budget cap, idle timeout, or absolute session cap | Check `/api/voice/status` budget fields and the caps above. |
| `The call dropped and could not be restored.` | Two transport failures in one call | Tap **Call again**. Reconnect is deliberately bounded to one attempt per call. |

---

## 9. Verification

Automated gates (no OpenAI call is made by any of them):

```bash
npx tsc --noEmit                                  # strict typecheck (src)
npx tsc -p tsconfig.test.json --noEmit            # strict typecheck (src + tests)
npm test                                          # full suite, zero skips
npm run build                                     # production build
npx tsx --test tests/private-voice-smoke.test.ts  # mocked provider lifecycle
```

Proving real microphone and WebRTC interoperability requires a separate,
explicitly authorised operator smoke against OpenAI. Until that is run, describe
the state as **automated and mock verified**, not "live verified".
