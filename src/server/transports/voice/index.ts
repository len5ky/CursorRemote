import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Transport } from '../types.js';
import type { VoiceConfig } from '../../types.js';
import type { VoiceHermesAgent } from './hermes-chat.js';
import { RealtimeBridge, type ClientSecretResult, type RealtimeBridgeOptions } from './realtime-bridge.js';
import { VOICE_REALTIME_MODEL, VOICE_MAX_CALL_ID_LENGTH } from './constants.js';
import { VoiceSessionController, type VoiceSessionContext, type VoiceSessionStatus } from './session.js';

const ORPHAN_HANGUP_ATTEMPTS = 2;
const ORPHAN_HANGUP_RETRY_DELAY_MS = 100;
const ATTACH_TOKEN_TTL_MS = 120_000;

/**
 * How long a certified Hermes tool policy is trusted before it is re-checked.
 *
 * The deployment could be reconfigured underneath a long-running relay, and the
 * whole read-only guarantee rests on that report, so it is not certified once
 * at boot and believed forever.
 */
const HERMES_POLICY_TTL_MS = 600_000;

type VoiceHealth = { voice: boolean; sideband: boolean; socket: boolean; hermes: boolean };

/**
 * What actually happened to the provider-side call during termination.
 *
 * - `no_provider_call` — the session never held a provider call id, so there
 *   was nothing to hang up. This is a complete outcome, not a confirmation.
 * - `confirmed` — the provider acknowledged the hangup.
 * - `unresolved` — a provider call existed and the hangup was not acknowledged.
 *   The orphan reaper may still be retrying.
 * - `unknown` — this request was not the authority for the termination (stale
 *   session, or a concurrent terminate owns the outcome).
 */
export type VoiceProviderCallCleanup = 'no_provider_call' | 'confirmed' | 'unresolved' | 'unknown';

export interface VoiceTerminationStatus {
  sessionId: string | null;
  epoch: number | null;
  state: VoiceSessionStatus['state'];
  providerCallCleanup: VoiceProviderCallCleanup;
  /**
   * True only when a provider call existed and the provider acknowledged the
   * hangup. Absence of a call id is never confirmation — see
   * VoiceProviderCallCleanup.
   */
  providerHangupConfirmed: boolean;
  reason: string;
}

interface AttachGrant {
  token: string;
  owner: string;
  sessionId: string;
  epoch: number;
  expiresAt: number;
}

/**
 * Owns admission, sideband attachment, Hermes policy certification, and
 * idempotent cleanup.
 *
 * The transport intentionally has no dependency on the general web mutation
 * surface, and no conversational capability of its own: every word spoken on a
 * call comes back from the private Hermes deployment through VoiceHermesAgent.
 */
export class VoiceTransport implements Transport {
  readonly name = 'voice';

  private readonly config: VoiceConfig;
  private readonly bridge: RealtimeBridge;
  private readonly sessions: VoiceSessionController;
  private readonly hermes: VoiceHermesAgent;
  private started = false;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private socketHealthy: () => boolean = () => false;
  private onHangup: ((status: VoiceTerminationStatus, owner: string) => void) | null = null;
  /**
   * In-flight termination work, keyed by `sessionId:epoch`.
   *
   * A single shared promise was returned to whichever caller happened to
   * arrive while any termination was running, so a request to end session B
   * resolved with session A's identity, epoch, reason and provider-cleanup
   * state. Keying the work per session keeps concurrent terminations of the
   * *same* session collapsed onto one provider hangup while making it
   * impossible for one session to be handed another's promise or result.
   */
  private readonly terminating = new Map<string, Promise<VoiceTerminationStatus>>();
  private readonly completedTerminations = new Map<string, VoiceTerminationStatus>();
  private readonly completedOwners = new Map<string, string>();
  private readonly orphanHangups = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attachGrants = new Map<string, AttachGrant>();
  /** Result of the last Hermes tool-policy certification, and when it was made. */
  private hermesPolicyOk = false;
  private hermesPolicyCheckedAt = 0;
  private hermesPolicyInFlight: Promise<boolean> | null = null;

  /**
   * @param hermes The private Hermes deployment, and the only conversational
   *   authority on this surface. Its session identity is server state; nothing
   *   a client sends can select or influence it.
   * @param providerOptions Transport seams for the provider connection. Tests
   *   inject a fetch/WebSocket double here so the lifecycle can be exercised
   *   without a real Realtime call. The model is never injectable — it is pinned
   *   to VOICE_REALTIME_MODEL.
   */
  constructor(
    config: VoiceConfig,
    dataDir: string,
    hermes: VoiceHermesAgent,
    providerOptions: RealtimeBridgeOptions = {},
  ) {
    this.config = config;
    this.hermes = hermes;
    this.sessions = new VoiceSessionController({
      dataPath: join(dataDir, 'voice-usage.json'),
      priceVersion: config.usagePriceVersion,
      unitPriceCentsPerMinute: config.usageUnitPriceCentsPerMinute,
      dailyCapCents: config.usageDailyCapCents,
      perSessionCapCents: config.usagePerSessionCapCents,
      absoluteSessionMs: config.sessionAbsoluteMs,
      idleMs: config.sessionIdleMs,
      idleGraceMs: config.sessionIdleGraceMs,
      leaseMs: config.sessionLeaseMs,
    });

    this.bridge = new RealtimeBridge(config, this.hermes, {
      accepts: (context) => this.sessions.accept(context),
      userTurn: (context) => { this.sessions.touch(context); },
      providerFailure: (context, reason) => { this.terminateDetached(context.sessionId, context.epoch, reason); },
      reportSpend: (context, cents, source) => this.sessions.reportSpend(context, cents, source),
    }, providerOptions);
  }

  get currentOwner(): string | null {
    return this.sessions.currentOwner();
  }

  private ownerFor(owner: string | undefined): string {
    return owner ?? 'local';
  }

  /**
   * Who is entitled to act on, or observe, the named session.
   *
   * A completed termination is owned by whoever ran it, for as long as its
   * record is retained — the record still holds that operator's session id,
   * epoch, provider-cleanup state and termination reason, and `terminate()`
   * replays it verbatim for that key. The live owner used to win this
   * comparison, so as soon as the next operator was admitted to this
   * single-session transport, *they* satisfied the gate for the previous
   * operator's completed key and were handed its cached status — while the
   * operator who actually ran it started getting 403 on their own session.
   * Per-key ownership therefore takes precedence, and the live owner answers
   * only for keys with no completed record of their own.
   */
  private assertOwner(owner: string | undefined, sessionId?: string, epoch?: number): void {
    if (owner === undefined) return;
    const completedOwner = sessionId !== undefined && epoch !== undefined
      ? this.completedOwners.get(`${sessionId}:${epoch}`)
      : undefined;
    if ((completedOwner ?? this.sessions.currentOwner()) !== owner) {
      throw Object.assign(new Error('unauthorized'), { statusCode: 403 });
    }
  }

  /**
   * Certify — or re-certify — that the configured Hermes deployment is private,
   * has MCP disabled and reports `api_server.toolsets` as exactly `[]`.
   *
   * The Hermes session-chat API has no per-request tool disable, so this report
   * is the only enforcement point there is. It fails closed on every error
   * path, and concurrent callers share one in-flight check rather than
   * stampeding the deployment.
   */
  private async ensureHermesPolicy(): Promise<boolean> {
    const fresh = this.hermesPolicyOk && Date.now() - this.hermesPolicyCheckedAt < HERMES_POLICY_TTL_MS;
    if (fresh) return true;
    if (this.hermesPolicyInFlight) return this.hermesPolicyInFlight;

    this.hermesPolicyInFlight = (async () => {
      let verdict: Awaited<ReturnType<VoiceHermesAgent['verifyPolicy']>>;
      try {
        verdict = await this.hermes.verifyPolicy();
      } catch {
        verdict = { ok: false, reason: 'hermes_policy_check_failed' };
      }
      this.hermesPolicyOk = verdict.ok;
      this.hermesPolicyCheckedAt = Date.now();
      if (!verdict.ok) {
        console.error(`[voice] Hermes tool policy not certified (${verdict.reason}); voice stays unavailable`);
      }
      return verdict.ok;
    })();

    try {
      return await this.hermesPolicyInFlight;
    } finally {
      this.hermesPolicyInFlight = null;
    }
  }

  private sweepAttachGrants(): void {
    const now = Date.now();
    for (const [key, grant] of this.attachGrants) {
      if (grant.expiresAt <= now) this.attachGrants.delete(key);
    }
  }

  /**
   * @param ownerKey The authenticated web session, or `local`. It authorizes
   *   the call and routes its events — it is never the budget identity, because
   *   it changes on every login and a per-login budget is not a budget.
   */
  async mintClientSecret(ownerKey: string): Promise<ClientSecretResult & { sessionId: string; epoch: number; attachToken: string }> {
    // Nothing is admitted against an uncertified Hermes deployment. A call that
    // came up anyway would be a live microphone wired to a conversational
    // backend whose tool policy nobody has verified.
    //
    // 503, not 500: this is not something that broke unexpectedly, it is a
    // precondition the deployment has not met, and the surface is deliberately
    // refusing. The caller is told only that voice is unavailable — which
    // precondition failed is operator diagnostics and stays in the log.
    if (!await this.ensureHermesPolicy()) {
      throw Object.assign(
        new Error('voice is unavailable until the private Hermes deployment certifies its tool policy'),
        { statusCode: 503 },
      );
    }
    const admitted = this.sessions.admit(ownerKey, this.config.accountId);
    if (!admitted.ok || !admitted.context) throw new Error(admitted.error ?? 'voice admission denied');
    const context = admitted.context;
    const owner = this.ownerFor(ownerKey === 'local' ? undefined : ownerKey);
    const attachToken = randomBytes(32).toString('base64url');
    const key = `${context.sessionId}:${context.epoch}`;
    this.attachGrants.set(key, {
      token: attachToken,
      owner,
      sessionId: context.sessionId,
      epoch: context.epoch,
      expiresAt: Date.now() + ATTACH_TOKEN_TTL_MS,
    });
    try {
      // The provider is given a hash of the *stable* account, so its abuse
      // signal follows the operator rather than resetting on every login.
      const secret = await this.bridge.mintClientSecret(this.config.accountId);
      return { ...secret, sessionId: context.sessionId, epoch: context.epoch, attachToken };
    } catch (err) {
      this.attachGrants.delete(key);
      await this.terminate(context.sessionId, context.epoch, 'provider_admission_failed');
      throw err;
    }
  }

  async attachCall(
    callId: string,
    sessionId: string,
    epoch: number,
    attachToken: string,
    owner?: string,
  ): Promise<void> {
    this.assertOwner(owner, sessionId, epoch);
    this.sweepAttachGrants();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(callId) || callId.length > VOICE_MAX_CALL_ID_LENGTH) throw new Error('invalid call id');
    if (typeof attachToken !== 'string' || attachToken.length < 32 || attachToken.length > 256) throw new Error('invalid attach token');
    const key = `${sessionId}:${epoch}`;
    const grant = this.attachGrants.get(key);
    if (!grant || grant.sessionId !== sessionId || grant.epoch !== epoch || grant.owner !== this.ownerFor(owner)) {
      throw new Error('voice attach grant is invalid or expired');
    }
    const expected = Buffer.from(grant.token);
    const received = Buffer.from(attachToken);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error('voice attach grant is invalid or expired');
    }
    // Consume before awaiting provider I/O. Replays cannot attach a second sideband.
    this.attachGrants.delete(key);
    const context = this.sessions.currentContext();
    if (!context || context.sessionId !== sessionId || context.epoch !== epoch || !this.sessions.activate(context)) {
      throw new Error('voice session is no longer admitting');
    }
    try {
      await this.bridge.attachSideband(callId, context);
    } catch (err) {
      await this.terminate(sessionId, epoch, 'sideband_attach_failed');
      throw err;
    }
  }

  async terminate(sessionId: string, epoch: number, reason = 'client_request', owner?: string): Promise<VoiceTerminationStatus> {
    const key = `${sessionId}:${epoch}`;
    this.assertOwner(owner, sessionId, epoch);
    const completed = this.completedTerminations.get(key);
    if (completed) return completed;
    const inFlight = this.terminating.get(key);
    if (inFlight) return inFlight;

    const context = this.sessions.currentContext();
    if (!context || context.sessionId !== sessionId || context.epoch !== epoch) {
      // The transport holds nothing for the session that was named. Echo the
      // caller's own identifiers back rather than the live session's: a stale
      // request is not entitled to learn which session *is* current, and a
      // caller that saw someone else's id here would act on a call it does not
      // own. `idle` is what this transport knows about the named session — not
      // a claim about whatever else may be running.
      return {
        sessionId,
        epoch,
        state: 'idle',
        providerCallCleanup: 'unknown',
        providerHangupConfirmed: false,
        reason: 'stale_session',
      };
    }
    if (!this.sessions.beginTermination(context).accepted) {
      // A concurrent terminate owns the provider outcome; this caller cannot
      // observe it, so it reports neither confirmation nor failure.
      const status = this.sessions.status();
      return {
        sessionId,
        epoch,
        state: status.state,
        providerCallCleanup: 'unknown',
        providerHangupConfirmed: false,
        reason,
      };
    }

    // Resolved while the session is still live: finishTermination clears the
    // account key, so currentOwner() is null by the time the hangup is
    // announced and a later lookup would lose the only routing key there is.
    const terminationOwner = this.ownerFor(owner ?? this.sessions.currentOwner() ?? undefined);

    const work = (async () => {
      this.attachGrants.delete(key);
      const callId = this.bridge.detach(context);
      const providerFailed = reason.startsWith('provider_') || reason.startsWith('sideband_');
      // No call id means there was never a provider call to hang up. That is a
      // distinct outcome from a confirmed hangup and must never be reported as
      // one — but it still leaves nothing outstanding, so it terminates clean.
      const providerCallCleanup: VoiceProviderCallCleanup = callId
        ? (await this.bridge.hangup(callId) ? 'confirmed' : 'unresolved')
        : 'no_provider_call';
      const cleanShutdown = providerCallCleanup !== 'unresolved' && !providerFailed;
      const state = this.sessions.finishTermination(context, cleanShutdown).state;
      const result: VoiceTerminationStatus = {
        sessionId,
        epoch,
        state,
        providerCallCleanup,
        providerHangupConfirmed: providerCallCleanup === 'confirmed',
        reason,
      };
      this.completedTerminations.set(key, result);
      this.completedOwners.set(key, terminationOwner);
      if (this.completedTerminations.size > 16) {
        const oldest = this.completedTerminations.keys().next().value;
        if (oldest) {
          this.completedTerminations.delete(oldest);
          this.completedOwners.delete(oldest);
        }
      }
      this.announceHangup(result, terminationOwner);
      if (callId && providerCallCleanup === 'unresolved') this.reapOrphanHangup(callId, result, terminationOwner);
      return result;
    })();
    this.terminating.set(key, work);
    try {
      return await work;
    } finally {
      // Only ever clears this session's own entry, so a slow termination
      // cannot drop a concurrent one belonging to a different session.
      this.terminating.delete(key);
    }
  }

  /**
   * Terminate on behalf of an internal caller that has no one to await it — the
   * lease reaper and the provider-failure path. A bare `void this.terminate(…)`
   * turned any failure into an unhandled rejection; the failure is a server-side
   * log line instead, and there is no client to report it to.
   */
  private terminateDetached(sessionId: string, epoch: number, reason: string): void {
    void this.terminate(sessionId, epoch, reason).catch(() => {
      console.error('[voice] Internal termination failed');
    });
  }

  heartbeat(sessionId: string, epoch: number, owner?: string): boolean {
    if (owner !== undefined && this.sessions.currentOwner() !== owner) return false;
    return this.sessions.heartbeat(sessionId, epoch);
  }

  setSocketHealthProvider(provider: () => boolean): void {
    this.socketHealthy = provider;
  }

  /**
   * The handler is told *whose* call ended, not just that one did. A hangup
   * carries the session id, epoch, termination reason and provider-cleanup
   * state of one account; without the owner the only thing a transport can do
   * with it is broadcast, which hands those details to every other logged-in
   * operator.
   */
  setHangupHandler(handler: (status: VoiceTerminationStatus, owner: string) => void): void {
    this.onHangup = handler;
  }

  /**
   * Ownership of a status report follows the session it describes, including
   * after that session has terminated.
   *
   * The gate used to consult `currentOwner()`, which reports null at the
   * terminal transition — so the moment one operator hung up, the report
   * describing *their* call (session id, epoch, lifecycle state, spend,
   * remaining budget, start and last-activity times) became readable by every
   * other authenticated operator. `sessionOwner()` keeps answering for the
   * retained session, so the terminal report stays scoped to its owner while
   * still being idempotently readable by them, and a relay that has never
   * admitted a session stays readable by anyone.
   */
  statusFor(owner?: string): ReturnType<VoiceTransport['_status']> | null {
    if (owner === undefined) return this._status();
    const sessionOwner = this.sessions.sessionOwner();
    if (sessionOwner !== null && sessionOwner !== owner) return null;
    return this._status();
  }

  get status(): ReturnType<VoiceTransport['_status']> {
    return this._status();
  }

  private _status(): {
    connected: boolean;
    sessionId: string | null;
    epoch: number | null;
    state: VoiceSessionStatus['state'];
    idleStatus: VoiceSessionStatus['idleStatus'];
    hermesCertified: boolean;
    health: VoiceHealth;
    budget: VoiceSessionStatus['budget'];
  } {
    const session = this.sessions.status();
    const context = this.sessions.currentContext();
    return {
      connected: !!context && this.bridge.connectedFor(context),
      sessionId: session.sessionId,
      epoch: session.epoch,
      state: session.state,
      idleStatus: session.idleStatus,
      // "Can this surface hold a conversation at all" — i.e. is there a
      // currently certified private Hermes deployment behind it. It reads the
      // same fact admission gates on, TTL included, so the status report and
      // the mint route cannot disagree. It is not a claim about any one turn.
      hermesCertified: this.available,
      health: {
        voice: !!context && this.sessions.accept(context),
        sideband: !!context && this.bridge.connectedFor(context),
        socket: this.socketHealthy(),
        hermes: this.available,
      },
      budget: session.budget,
    };
  }

  /**
   * Announce a completed hangup without letting the announcement decide whether
   * the termination succeeded.
   *
   * The handler is relay-supplied (it emits into a socket.io room), and it ran
   * inside the termination promise. A throw there rejected the termination
   * itself — which the reaper and the provider-failure path both start with no
   * caller to await them, so it surfaced as an unhandled rejection about a
   * session that had in fact ended cleanly.
   */
  private announceHangup(result: VoiceTerminationStatus, owner: string): void {
    try {
      this.onHangup?.(result, owner);
    } catch {
      console.error('[voice] Hangup announcement failed');
    }
  }

  private reapOrphanHangup(callId: string, result: VoiceTerminationStatus, owner: string): void {
    if (this.orphanHangups.has(callId)) return;
    let attempts = 0;
    const retry = async (): Promise<void> => {
      attempts++;
      const confirmed = await this.bridge.hangup(callId).catch(() => false);
      if (confirmed) {
        this.orphanHangups.delete(callId);
        result.providerCallCleanup = 'confirmed';
        result.providerHangupConfirmed = true;
        this.announceHangup(result, owner);
        return;
      }
      if (attempts >= ORPHAN_HANGUP_ATTEMPTS) {
        this.orphanHangups.delete(callId);
        console.warn('[voice] Provider hangup retry budget exhausted');
        return;
      }
      schedule();
    };
    const schedule = (): void => {
      const timer = setTimeout(() => { void retry(); }, ORPHAN_HANGUP_RETRY_DELAY_MS);
      timer.unref();
      this.orphanHangups.set(callId, timer);
    };
    schedule();
  }

  /**
   * True only when a call can actually be placed right now: the private Hermes
   * deployment has certified, within the policy TTL, that it is private, has
   * MCP disabled and exposes zero `api_server` toolsets.
   *
   * This is the transport's own answer about itself, and it is the same fact
   * admission gates on — so the status report, the boot log and the mint route
   * cannot disagree about whether voice works.
   */
  get available(): boolean {
    return this.hermesPolicyOk && Date.now() - this.hermesPolicyCheckedAt < HERMES_POLICY_TTL_MS;
  }

  /**
   * Bring the transport up, and say plainly whether it came up usable.
   *
   * The Hermes tool policy is certified here so a misconfigured or unreachable
   * deployment is visible at boot rather than at 70km/h. It is deliberately not
   * fatal: the relay also serves the web and Telegram surfaces, and killing all
   * of them over a Hermes blip would be a worse failure than an unavailable
   * voice button. What must not happen is voice coming up *looking* fine —
   * admission stays closed, the boot log says so, and `/api/voice/status`
   * reports it.
   *
   * The reaper starts either way. Leases, budgets and orphaned provider calls
   * still have to be cleaned up on a transport that is refusing new calls.
   */
  async start(): Promise<void> {
    this.started = true;
    const certified = await this.ensureHermesPolicy();
    this.reaper = setInterval(() => {
      for (const expired of this.sessions.reap()) {
        this.terminateDetached(expired.context.sessionId, expired.context.epoch, expired.reason);
      }
    }, Math.min(this.config.sessionLeaseMs, 5_000));
    if (certified) {
      console.log(`[voice] Transport ready (model: ${VOICE_REALTIME_MODEL}, voice: ${this.config.voice})`);
    } else {
      console.error(
        '[voice] Transport started UNAVAILABLE: the private Hermes deployment has not certified its tool policy. '
        + 'No call can be placed until it does. Check VOICE_HERMES_API_URL reachability and that the deployment '
        + 'reports a private deployment, MCP disabled and zero api_server toolsets.'
      );
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    const context = this.sessions.currentContext();
    if (context) {
      // Shutdown must still release timers, grants and the sideband even if the
      // final termination fails.
      try {
        await this.terminate(context.sessionId, context.epoch, 'transport_stop');
      } catch {
        console.error('[voice] Termination during shutdown failed');
      }
    }
    for (const timer of this.orphanHangups.values()) clearTimeout(timer);
    this.orphanHangups.clear();
    this.attachGrants.clear();
    console.log('[voice] Transport stopped');
  }
}
