import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import type { ServerConfig, CursorState, CommandPayload, CommandResult } from './types.js';
import type { StateManager } from './state-manager.js';
import type { CommandExecutor } from './command-executor.js';
import type { CDPBridge } from './cdp-bridge.js';
import { markdownToWebHtml, readPlanFile } from './plan-files.js';
import {
  WEBAPP_SESSION_COOKIE,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from './webapp-sessions.js';
import type { VoiceTransport } from './transports/voice/index.js';
import { createVoiceOriginPolicy, type VoiceOriginPolicy } from './transports/voice/origin-policy.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { truncateUtf8 } from './transports/voice/tools.js';
import { resolveLoginIdentity } from './request-identity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Rate-limit budgets. `maxKeys` bounds the tables: the login limiter is keyed
 * by verified identity or peer address and the voice limiter by authenticated
 * session, so neither can be grown without limit by a caller, but both are
 * capped anyway.
 */
const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 60_000, maxKeys: 4_096 } as const;
/**
 * The abuse guard that survives *above* per-identity buckets.
 *
 * Giving each verified Tailscale identity its own bucket is what stops one
 * operator's typos locking out the tailnet — but it also means the number of
 * buckets is the number of identities. This is the ceiling on login attempts as
 * a whole, so no amount of identity churn buys unlimited password guesses.
 */
const LOGIN_GLOBAL_RATE_LIMIT = { limit: 60, windowMs: 60_000, maxKeys: 1 } as const;
const VOICE_RATE_LIMIT = { limit: 30, windowMs: 60_000, maxKeys: 4_096 } as const;

/**
 * The private voice assets, and the only URL paths that may reach them.
 *
 * They live in the same directory as the public client, which `express.static`
 * serves wholesale. A route registered before that mount matches one exact
 * string; the static mount does not — it decodes the pathname and then
 * `path.normalize`s it, so `//voice.js`, `/./voice.js`, `/voice%2Ejs` and
 * `/a/../voice.js` all resolved to the same file while missing the route match
 * entirely, and came back with no session check, no CSP, no `Permissions-Policy`
 * and a cacheable `Cache-Control`.
 *
 * So the request path is normalized the same way `send` normalizes it, and any
 * spelling that lands on a private asset is claimed here — before the static
 * mount can ever see it.
 */
const VOICE_PRIVATE_ASSETS: ReadonlyMap<string, { file: string; type: string }> = new Map([
  ['/voice', { file: 'voice.html', type: 'html' }],
  ['/voice.html', { file: 'voice.html', type: 'html' }],
  ['/voice.js', { file: 'voice.js', type: 'js' }],
  ['/voice.css', { file: 'voice.css', type: 'css' }],
]);

/** Where an unauthenticated voice request is sent back to after logging in. */
const VOICE_LOGIN_RETURN_PATH = '/voice';

/**
 * Resolve a request path to the file `express.static`/`send` would resolve it
 * to: percent-decoded once, empty and `.` segments dropped, `..` popped.
 *
 * Returns `null` for a path that cannot be decoded or carries a NUL — `send`
 * refuses those too, so refusing here keeps the two in step rather than letting
 * one of them make a decision the other has not seen.
 */
export function normalizeRequestPath(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/**
 * Where the login page sends the operator afterwards.
 *
 * The voice PWA is installed at the `/voice` scope, so bouncing a login through
 * the origin root drops the operator out of the installed app and into the
 * remote-control client. The return target is therefore honoured — but only
 * from a closed allow-list, because "same-origin path" is not a property that
 * survives contact with `//evil.example/x` or `javascript:`.
 */
const LOGIN_REDIRECT_TARGETS: ReadonlySet<string> = new Set(['/voice', '/voice.html']);

export function resolveLoginRedirect(raw: unknown): string {
  return typeof raw === 'string' && LOGIN_REDIRECT_TARGETS.has(raw) ? raw : '/';
}

/**
 * Render a caught value for the *server log only*.
 *
 * Bounded so a hostile upstream cannot flood the log through an error message,
 * and stack-free because a stack in a log line is noise the operator has to
 * scroll past. Never pass the result to a response body.
 */
function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

function loginPageHtml(nextPath: string): string {
  // `nextPath` is one of a closed set of literals (see resolveLoginRedirect),
  // JSON-encoded into a script literal. Nothing caller-supplied reaches here.
  return LOGIN_PAGE_TEMPLATE.replace('__LOGIN_REDIRECT__', JSON.stringify(nextPath));
}

const LOGIN_PAGE_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#1a1a2e">
  <title>CursorRemote - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #181818;
      color: rgba(228,228,228,0.92);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100dvh;
    }
    .login-card {
      width: 100%; max-width: 340px; padding: 32px 24px;
      background: #232323; border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; text-align: center; }
    .subtitle { font-size: 13px; color: rgba(228,228,228,0.5); margin-bottom: 24px; text-align: center; }
    label { display: block; font-size: 13px; margin-bottom: 6px; color: rgba(228,228,228,0.7); }
    input[type="password"] {
      width: 100%; padding: 10px 12px; font-size: 15px;
      background: #181818; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px;
      color: rgba(228,228,228,0.92); outline: none;
    }
    input[type="password"]:focus { border-color: #3794ff; }
    button {
      width: 100%; padding: 10px; margin-top: 16px; font-size: 15px; font-weight: 500;
      background: #3794ff; color: #fff; border: none; border-radius: 8px; cursor: pointer;
    }
    button:hover { background: #2b7ee0; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #e34671; font-size: 13px; margin-top: 12px; text-align: center; display: none; }
  </style>
</head>
<body>
  <form class="login-card" id="form">
    <h1>CursorRemote</h1>
    <p class="subtitle">Enter password to continue</p>
    <label for="pw">Password</label>
    <input type="password" id="pw" name="password" autocomplete="current-password" autofocus required>
    <button type="submit" id="btn">Sign in</button>
    <p class="error" id="err"></p>
  </form>
  <script>
    const form = document.getElementById('form');
    const pw = document.getElementById('pw');
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.style.display = 'none';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('cursor-remote-token', data.token);
          window.location.href = __LOGIN_REDIRECT__;
        } else {
          err.textContent = data.error || 'Invalid password';
          err.style.display = 'block';
        }
      } catch {
        err.textContent = 'Network error';
        err.style.display = 'block';
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`;

export class Relay {
  private config: ServerConfig;
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private io: SocketServer;
  private stateManager: StateManager;
  private commandExecutor: CommandExecutor;
  private cdpBridge: CDPBridge;

  private sessionStore: WebappSessionStore;
  private loginLimiter = new FixedWindowRateLimiter(LOGIN_RATE_LIMIT);
  private loginGlobalLimiter = new FixedWindowRateLimiter(LOGIN_GLOBAL_RATE_LIMIT);
  private voiceLimiter = new FixedWindowRateLimiter(VOICE_RATE_LIMIT);
  private voiceTransport: VoiceTransport | null = null;
  private voiceOriginPolicy: VoiceOriginPolicy;
  /** Authenticated session tokens with ≥ 1 connected socket.io client. */
  private activeSockets = new Map<string, number>();

  /** Max-Age for session cookie (30 days), aligned with typical “stay signed in” expectation. */
  private static readonly SESSION_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

  /**
   * Room holding every socket authenticated as one account. The prefix keeps
   * the name out of socket.io's per-socket id room namespace, and it matches
   * VoiceTransport's owner key — the session token, or `local` when the relay
   * runs unauthenticated.
   */
  private static accountRoom(owner: string): string {
    return `acct:${owner}`;
  }

  private get authEnabled(): boolean {
    return this.config.webappPassword.length > 0;
  }

  /**
   * Voice is enabled but no password is configured. loadConfig() refuses to
   * build such a config at all; this is the second gate, so a relay assembled
   * any other way still cannot serve the voice surface open to the tailnet.
   */
  private get voiceUnprotected(): boolean {
    return this.config.voice?.enabled === true && !this.authEnabled;
  }

  /** Logged once per process: the misconfiguration is static, the callers are not. */
  private voiceUnprotectedLogged = false;

  /**
   * Refuse, and tell the caller nothing about why.
   *
   * This surface is reachable by anything that can hit the port, including an
   * unauthenticated caller. Naming the missing setting in the response body
   * would hand that caller a map of how the deployment is wired, so the setting
   * name goes to the operator's log and the caller gets a bare refusal.
   */
  private refuseUnprotectedVoice(res: express.Response): void {
    if (!this.voiceUnprotectedLogged) {
      this.voiceUnprotectedLogged = true;
      console.error(
        '[relay] Voice is enabled but WEBAPP_PASSWORD is not set; '
        + 'the private voice surface refuses to run unauthenticated. '
        + 'Set WEBAPP_PASSWORD or disable voice.',
      );
    }
    res.status(503).json({ error: 'Voice is unavailable.' });
  }

  constructor(
    config: ServerConfig,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.sessionStore = createWebappSessionStore(config.dataDir);
    this.voiceOriginPolicy = createVoiceOriginPolicy({
      publicOrigin: config.voice?.publicOrigin ?? '',
      serverPort: config.serverPort,
    });

    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketServer(this.httpServer, {
      serveClient: false,
      cors: {
        // `origin: true` reflects whatever Origin the caller sent and, with
        // `credentials: true`, tells the browser to attach the session cookie
        // to it — which is not a CORS policy, it is the absence of one. The
        // allow set is the same validated canonical origin (plus the loopback
        // development origins) the voice routes already enforce.
        origin: [...this.voiceOriginPolicy.allowed],
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupStateForwarding();

    if (this.authEnabled) {
      console.log('[relay] Web app password protection enabled');
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.serverPort, this.config.serverHost, () => {
        console.log(
          `[relay] Server listening on http://${this.config.serverHost}:${this.config.serverPort}`
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.io.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  /**
   * The real peer address, never `X-Forwarded-For`.
   *
   * The relay binds loopback and the documented deployment is Tailscale Serve
   * forwarding to it, so every request arrives from 127.0.0.1 and any
   * `X-Forwarded-*` header is simply whatever the caller typed. Keying a rate
   * limit off that let one client rotate the header and mint an unlimited
   * number of fresh buckets, which made the login limit decorative.
   */
  private getClientIp(req: express.Request): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** First matching credential that exists in the persisted session store. */
  private resolveHttpSession(req: express.Request): string | undefined {
    if (!this.authEnabled) return undefined;
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (this.sessionStore.has(t)) return t;
    }
    const fromCookie = parseSessionCookie(req.headers.cookie, WEBAPP_SESSION_COOKIE);
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private resolveSocketSession(socket: Socket): string | undefined {
    if (!this.authEnabled) return undefined;
    const raw = socket.handshake.auth?.token;
    const bearer = typeof raw === 'string' ? raw.trim() : '';
    if (bearer && this.sessionStore.has(bearer)) return bearer;
    const cookieHeader = socket.handshake.headers.cookie;
    const fromCookie = parseSessionCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      WEBAPP_SESSION_COOKIE
    );
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  /** Attach the voice transport after construction (started later in main). */
  setVoiceTransport(transport: VoiceTransport): void {
    this.voiceTransport = transport;
    transport.setSocketHealthProvider(() => {
      if (!this.authEnabled) return this.io.engine.clientsCount > 0;
      const owner = this.voiceTransport?.currentOwner;
      if (!owner) return false;
      return (this.activeSockets.get(owner) ?? 0) > 0;
    });
    // Scoped to the owning account's room, never broadcast: a hangup carries
    // one account's session id, epoch, reason and provider-cleanup state, and a
    // client keying its UI off `voice:hangup` would tear down a call it does
    // not own. Every socket the owner has open is in the room, so multiple tabs
    // still all receive it.
    transport.setHangupHandler((status, owner) => {
      this.io.to(Relay.accountRoom(owner)).emit('voice:hangup', status);
    });
  }

  private setupRoutes(): void {
    const clientDir = join(__dirname, '..', 'client');

    this.app.use(express.json({ limit: '16kb' }));

    // `navigator.sendBeacon` is the only way a hiding page can still ask for a
    // hangup, and a beacon built from a bare string is delivered as
    // text/plain — which express.json() leaves unparsed, so the request used to
    // 400 and the call survived until the reaper. Accept the text body on the
    // voice routes and decode it as JSON, without loosening any other route.
    const normalizeVoiceBeaconBody: express.RequestHandler = (req, res, next) => {
      if (typeof req.body !== 'string') return next();
      const raw = req.body.trim();
      if (raw.length === 0) {
        req.body = {};
        return next();
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return res.status(400).json({ error: 'Malformed voice request body' });
        }
        req.body = parsed;
      } catch {
        return res.status(400).json({ error: 'Malformed voice request body' });
      }
      return next();
    };
    this.app.use(
      '/api/voice',
      express.text({ type: ['text/plain', 'text/*'], limit: '16kb' }),
      normalizeVoiceBeaconBody,
    );

    // --- Voice ("car mode") endpoints. Auth-checked explicitly because they
    // are registered before the trailing auth middleware. ---
    const noStore = (res: express.Response): void => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    };
    const voiceAuthOk = (req: express.Request, res: express.Response): boolean => {
      noStore(res);
      if (this.voiceUnprotected) {
        this.refuseUnprotectedVoice(res);
        return false;
      }
      // The allow set comes from validated configuration only. req.protocol,
      // Host and every X-Forwarded-* header are attacker-controlled on a direct
      // request to the loopback port, and Tailscale Serve legitimately forwards
      // an https:// origin over plain http, so none of them are consulted here.
      if (!this.voiceOriginPolicy.allows(req.headers.origin)) {
        res.status(403).json({ error: 'Origin denied' });
        return false;
      }
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
      }
      // Authenticated identity first: one operator's traffic must not spend
      // another's budget, and the fallback is the real peer address, never a
      // caller-supplied one.
      const key = this.resolveHttpSession(req) ?? this.getClientIp(req);
      const rate = this.voiceLimiter.check(key);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfter));
        res.status(429).json({ error: 'Voice request rate limit exceeded' });
        return false;
      }
      return true;
    };

    this.app.post('/api/voice/token', async (req, res) => {
      if (!voiceAuthOk(req, res)) return;
      if (!this.voiceTransport) return res.status(503).json({ error: 'Voice transport not enabled' });
      try {
        const accountKey = this.resolveHttpSession(req) ?? 'local';
        const secret = await this.voiceTransport.mintClientSecret(accountKey);
        res.json({
          clientSecret: secret.clientSecret,
          expiresAt: secret.expiresAt ?? null,
          sessionId: secret.sessionId,
          epoch: secret.epoch,
          attachToken: secret.attachToken,
        });
      } catch (err) {
        // The provider's status/reason is operator diagnostics, not a response
        // body: it describes an upstream the caller has no business probing.
        console.error(`[voice] Client secret mint failed: ${errorDetail(err)}`);
        res.status(500).json({ error: 'Failed to start a voice session.' });
      }
    });

    this.app.post('/api/voice/call', async (req, res) => {
      if (!voiceAuthOk(req, res)) return;
      if (!this.voiceTransport) return res.status(503).json({ error: 'Voice transport not enabled' });
      const callId = typeof req.body?.callId === 'string' ? req.body.callId : '';
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      const attachToken = typeof req.body?.attachToken === 'string' ? req.body.attachToken : '';
      const epoch = Number.isSafeInteger(req.body?.epoch) ? req.body.epoch : -1;
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(callId) || !/^[A-Za-z0-9_-]{1,200}$/.test(sessionId) || !attachToken || epoch < 1) {
        return res.status(400).json({ error: 'Valid call, session, epoch, and attach token required' });
      }
      const owner = this.resolveHttpSession(req);
      try {
        await this.voiceTransport.attachCall(callId, sessionId, epoch, attachToken, owner);
        res.json({ ok: true });
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { statusCode?: number };
        if (e.statusCode === 403) {
          res.status(403).json({ error: 'Unauthorized' });
          return;
        }
        // Adapter/provider cause stays server-side; the caller learns only that
        // the attach did not happen.
        console.error(`[voice] Sideband attach failed: ${errorDetail(err)}`);
        res.status(409).json({ error: 'Voice session attach denied' });
      }
    });

    const terminateVoice = async (req: express.Request, res: express.Response): Promise<void> => {
      if (!voiceAuthOk(req, res)) return;
      if (!this.voiceTransport) {
        res.status(503).json({ error: 'Voice transport not enabled' });
        return;
      }
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      const epoch = Number.isSafeInteger(req.body?.epoch) ? req.body.epoch : -1;
      // Byte-bounded, and cut on a character boundary: the reason is caller
      // supplied and is echoed back in the termination status and the
      // `voice:hangup` payload, so a 120-*code-unit* cut through the middle of
      // a surrogate pair put half a code point on the wire.
      const reason = typeof req.body?.reason === 'string' ? truncateUtf8(req.body.reason, 120) : 'client_request';
      if (!sessionId || epoch < 1) {
        res.status(400).json({ error: 'sessionId and epoch required' });
        return;
      }
      const owner = this.resolveHttpSession(req);
      try {
        res.json(await this.voiceTransport.terminate(sessionId, epoch, reason, owner));
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { statusCode?: number };
        if (e.statusCode === 403) {
          res.status(403).json({ error: 'Unauthorized' });
          return;
        }
        // Re-throwing left this `async` handler — invoked as `void
        // terminateVoice(req, res)` — with nobody to catch it: an unhandled
        // rejection, and a request that never received a response at all, so
        // the phone's Hang up button just stalled. The cause (ledger path,
        // errno, provider status) is operator diagnostics and stays in the log.
        console.error(`[voice] Termination failed: ${errorDetail(err)}`);
        res.status(500).json({ error: 'Failed to end the voice session.' });
      }
    };

    this.app.post('/api/voice/terminate', (req, res) => { void terminateVoice(req, res); });
    this.app.post('/api/voice/disconnect', (req, res) => { void terminateVoice(req, res); });

    this.app.post('/api/voice/heartbeat', (req, res) => {
      if (!voiceAuthOk(req, res)) return;
      if (!this.voiceTransport) return res.status(503).json({ error: 'Voice transport not enabled' });
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      const epoch = Number.isSafeInteger(req.body?.epoch) ? req.body.epoch : -1;
      const owner = this.resolveHttpSession(req);
      if (!sessionId || epoch < 1 || !this.voiceTransport.heartbeat(sessionId, epoch, owner)) {
        return res.status(409).json({ error: 'Voice lease is no longer live' });
      }
      return res.json({ ok: true });
    });

    this.app.get('/api/voice/status', (req, res) => {
      if (!voiceAuthOk(req, res)) return;
      if (!this.voiceTransport) return res.json({ enabled: false });
      const owner = this.resolveHttpSession(req);
      const s = this.voiceTransport.statusFor(owner);
      if (s === null) return res.status(403).json({ error: 'Unauthorized' });
      res.json({
        enabled: true,
        ...s,
        estimatedSpendCents: s.budget.estimatedCents,
        reportedSpendCents: s.budget.reportedCents,
        remainingBudgetCents: s.budget.remainingCents,
      });
    });

    this.app.get('/login', (req, res) => {
      if (!this.authEnabled) return res.redirect('/');
      res.type('html').send(loginPageHtml(resolveLoginRedirect(req.query.next)));
    });

    // Open WebUI and other prior :3000 owners redirected failures to /error
    // and browsers cache that SvelteKit "500: Internal Error" document.
    // Serve a no-store HTML bounce so a reload of /error overwrites the cache.
    this.app.get('/error', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Clear-Site-Data', '"cache"');
      res.status(200).type('html').send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Cache-Control" content="no-store">
<meta http-equiv="refresh" content="0;url=/">
<title>CursorRemote</title>
</head><body style="font-family:system-ui;background:#1e1e1e;color:#ccc;padding:2rem">
<p>CursorRemote — redirecting…</p>
<p><a href="/" style="color:#3794ff">Open CursorRemote</a></p>
<script>location.replace('/');</script>
</body></html>`);
    });

    this.app.post('/api/login', (req, res) => {
      if (!this.authEnabled) return res.json({ token: 'no-auth' });

      const ip = this.getClientIp(req);
      // Behind Tailscale Serve every request arrives from 127.0.0.1, so a
      // peer-keyed limiter is one bucket for the whole tailnet: one operator's
      // ten typos lock out every other device. Verified Serve identity splits
      // that bucket — but only when the operator has declared the deployment
      // and only from a loopback peer, because on a direct request to this port
      // any header is simply whatever the caller typed. See request-identity.ts.
      const identity = resolveLoginIdentity({
        remoteAddress: req.socket.remoteAddress,
        headers: req.headers,
        trustTailscaleIdentity: this.config.trustTailscaleIdentity,
      });
      // Both counters are always consumed: the global guard has to see every
      // attempt, or minting a fresh identity per request would slip past it.
      const globalDecision = this.loginGlobalLimiter.check('all');
      const identityDecision = this.loginLimiter.check(identity.key);
      const { allowed, retryAfter } = globalDecision.allowed ? identityDecision : globalDecision;
      if (!allowed) {
        // The identity itself is a person's login and never reaches the log.
        console.warn(`[relay] Rate limited login from ${ip} (${identity.source})`);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfter}s.` });
      }

      const password = req.body?.password;
      if (typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: 'Password required' });
      }

      const expected = Buffer.from(this.config.webappPassword);
      const received = Buffer.from(password);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        console.warn(`[relay] Failed login attempt from ${ip}`);
        return res.status(401).json({ error: 'Invalid password' });
      }

      const token = randomBytes(32).toString('hex');
      this.sessionStore.add(token);
      console.log(`[relay] Successful login from ${ip}`);
      res.setHeader(
        'Set-Cookie',
        [
          `${WEBAPP_SESSION_COOKIE}=${token}`,
          'HttpOnly',
          'Path=/',
          'SameSite=Lax',
          `Max-Age=${Relay.SESSION_COOKIE_MAX_AGE_SEC}`,
        ].join('; ')
      );
      return res.json({ token });
    });

    this.app.get('/health', (req, res) => {
      const state = this.stateManager.getCurrentState();
      const sessionOk = !this.authEnabled || this.resolveHttpSession(req) !== undefined;
      res.json({
        ok: true,
        authRequired: this.authEnabled,
        sessionValid: sessionOk,
        connected: state.connected,
        extractorStatus: state.extractorStatus,
        lastExtractionAt: state.lastExtractionAt,
        consecutiveExtractionFailures: state.consecutiveExtractionFailures,
        lastExtractionError: state.lastExtractionError,
        agentStatus: state.agentStatus,
        clients: this.io.engine.clientsCount,
        uptime: process.uptime(),
        windows: state.windows,
        activeWindowId: state.activeWindowId,
        mode: state.mode?.current ?? null,
        model: state.model?.current ?? null,
        chatTabCount: state.chatTabs?.length ?? 0,
        pendingApprovalCount: state.pendingApprovals?.length ?? 0,
        generation: this.stateManager.generation,
      });
    });

    this.app.get('/debug/state', (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const state = this.stateManager.getCurrentState();
      res.json({
        activeWindowId: state.activeWindowId,
        agentStatus: state.agentStatus,
        agentActivityText: state.agentActivityText,
        agentActivityLive: state.agentActivityLive,
        pendingApprovals: state.pendingApprovals,
        chatTabs: state.chatTabs.map((t) => ({
          isActive: t.isActive,
          title: t.title,
          composerId: t.composerId.substring(0, 16),
        })),
        windows: state.windows.map((w) => ({ id: w.id.substring(0, 8), title: w.title })),
        messageCount: state.messages.length,
        lastMessages: state.messages.slice(-3).map((m) => ({
          type: m.type,
          flatIndex: m.flatIndex,
          ...(m.type === 'tool' || m.type === 'run_command' ? {
            actions: 'actions' in m ? m.actions?.length ?? 0 : 0,
          } : {}),
        })),
        generation: this.stateManager.generation,
      });
    });

    const cacheBust = Date.now().toString(36);
    this.app.get('/', (_req, res) => {
      const htmlPath = join(clientDir, 'index.html');
      try {
        let html = readFileSync(htmlPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)\.(js|css)"/g, `$1="$2.$3?v=${cacheBust}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html);
      } catch (err) {
        console.error(`[relay] Failed to serve index.html: ${err}`);
        res.status(500).send('Client files not found');
      }
    });

    // --- Private voice PWA surface. Claimed before express.static so the page
    // and its script are never reachable without an authenticated session, in
    // any spelling of their path; the manifest, worker and icons carry no
    // secrets and stay public so installability works before login. ---
    const voiceSecurityHeaders = (res: express.Response): void => {
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "media-src 'self' blob:",
        // The browser posts SDP straight to the provider; nothing else is reachable.
        "connect-src 'self' https://api.openai.com",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '));
      res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
    };

    const sendVoiceAsset = (res: express.Response, file: string, type: string): void => {
      try {
        voiceSecurityHeaders(res);
        res.type(type).send(readFileSync(join(clientDir, file), 'utf-8'));
      } catch (err) {
        console.error(`[relay] Failed to serve ${file}: ${err}`);
        res.status(500).send('Voice client not found');
      }
    };

    /**
     * One gate for every URL that resolves to a private voice asset.
     *
     * Registered with `use`, not `get`, so it sees the request *before* the
     * static mount regardless of how the path is spelled — and it compares the
     * normalized path, so an alias cannot slip past by being a different string
     * for the same file.
     */
    const voiceAssetGate: express.RequestHandler = (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();

      const normalized = normalizeRequestPath(req.path);
      if (normalized === null) {
        // Undecodable or NUL-bearing. `send` refuses these too; refusing here
        // means the static mount never gets to make its own decision about a
        // path this gate could not evaluate.
        res.status(400).send('Bad request');
        return;
      }

      const asset = VOICE_PRIVATE_ASSETS.get(normalized);
      if (!asset) return next();

      // With voice enabled and no password there is no session to acquire, so
      // redirecting to /login would loop. Refuse outright instead.
      if (this.voiceUnprotected) {
        this.refuseUnprotectedVoice(res);
        return;
      }
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        // Back to the voice page, not the origin root: the operator is in an
        // installed PWA scoped to /voice and must not be dropped out of it.
        res.redirect(`/login?next=${encodeURIComponent(VOICE_LOGIN_RETURN_PATH)}`);
        return;
      }
      sendVoiceAsset(res, asset.file, asset.type);
    };

    this.app.use(voiceAssetGate);

    this.app.use(express.static(clientDir, {
      etag: true,
      lastModified: true,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      },
    }));

    const authMiddleware: express.RequestHandler = (req, res, next) => {
      if (!this.authEnabled) return next();

      if (this.resolveHttpSession(req)) return next();

      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/login');
    };

    this.app.use(authMiddleware);
  }

  private setupSocketHandlers(): void {
    if (this.authEnabled) {
      this.io.use((socket, next) => {
        const resolved = this.resolveSocketSession(socket);
        if (resolved) return next();
        const raw = socket.handshake.auth?.token;
        const hint =
          typeof raw === 'string' && raw.length > 0
            ? raw.slice(0, 8) + '...'
            : parseSessionCookie(
                typeof socket.handshake.headers.cookie === 'string'
                  ? socket.handshake.headers.cookie
                  : undefined,
                WEBAPP_SESSION_COOKIE
              )
              ? 'cookie-present'
              : 'empty';
        console.warn(`[relay] Socket.io auth rejected (${socket.id}) — ${hint}`);
        next(new Error('Unauthorized'));
      });
    }

    this.io.on('connection', (socket) => {
      console.log(`[relay] Client connected: ${socket.id}`);

      // Track authenticated sessions for voice socket-health ownership
      const socketSessionToken = this.resolveSocketSession(socket);
      if (socketSessionToken) {
        this.activeSockets.set(socketSessionToken, (this.activeSockets.get(socketSessionToken) ?? 0) + 1);
      }
      // Account-scoped delivery target for voice events. Unauthenticated relays
      // have no token and share the `local` owner key used by VoiceTransport.
      socket.join(Relay.accountRoom(socketSessionToken ?? 'local'));

      socket.emit('state:full', this.stateManager.getCurrentState());

      socket.on('command:send_message', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.text) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or text',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: send_message from ${socket.id}`);
        const result = await this.commandExecutor.sendMessage(
          payload.commandId,
          payload.text
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve from ${socket.id}`);
        const result = await this.commandExecutor.clickApproval(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve_all', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve_all from ${socket.id}`);
        const result = await this.commandExecutor.approveAll(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:reject', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: reject from ${socket.id}`);
        const result = await this.commandExecutor.reject(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_tab', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.tabTitle && !payload.selectorPath)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and tab target',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_tab to "${payload.tabTitle ?? payload.selectorPath}" from ${socket.id}`);
        const result = await this.commandExecutor.switchTab(
          payload.commandId,
          payload.tabTitle ?? '',
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:new_chat', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: new_chat from ${socket.id}`);
        const result = await this.commandExecutor.newChat(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:set_mode', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modeId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modeId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_mode to ${payload.modeId} from ${socket.id}`);
        const result = await this.commandExecutor.setMode(
          payload.commandId,
          payload.modeId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_model to ${payload.modelId} from ${socket.id}`);
        const result = await this.commandExecutor.setModel(
          payload.commandId,
          payload.modelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getModelOptions(
          payload.commandId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_plan_full', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.planLabel) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or planLabel',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_full for ${payload.planLabel} from ${socket.id}`);
        const planFile = readPlanFile(payload.planLabel);
        if (!planFile) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Plan file not found',
          } satisfies CommandResult);
          return;
        }
        socket.emit('command:result', {
          commandId: payload.commandId,
          ok: true,
          data: {
            todos: planFile.todos,
            body: planFile.body,
            bodyHtml: markdownToWebHtml(planFile.body),
          },
        } satisfies CommandResult);
      });

      socket.on('command:get_plan_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getPlanModelOptions(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_plan_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath || !payload.planModelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, selectorPath, or planModelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_plan_model to ${payload.planModelId} from ${socket.id}`);
        const result = await this.commandExecutor.setPlanModel(
          payload.commandId,
          payload.selectorPath,
          payload.planModelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:click_action', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: click_action from ${socket.id}`);
        const result = await this.commandExecutor.clickAction(
          payload.commandId,
          payload.selectorPath,
          payload.actionLabel
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_window', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.windowId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or windowId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_window to ${payload.windowId} from ${socket.id}`);
        try {
          await this.cdpBridge.switchWindow(payload.windowId);
          socket.emit('command:result', { commandId: payload.commandId, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

      socket.on('disconnect', (reason) => {
        console.log(`[relay] Client disconnected: ${socket.id} (${reason})`);
        if (socketSessionToken) {
          const count = this.activeSockets.get(socketSessionToken) ?? 0;
          if (count <= 1) this.activeSockets.delete(socketSessionToken);
          else this.activeSockets.set(socketSessionToken, count - 1);
        }
      });
    });
  }

  private setupStateForwarding(): void {
    this.stateManager.on('state:patch', (patch: Partial<CursorState>) => {
      this.io.emit('state:patch', patch);
    });

    this.stateManager.on('connection:changed', (connected: boolean) => {
      this.io.emit('connection:status', { connected });
    });
  }
}
