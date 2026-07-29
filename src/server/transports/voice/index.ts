import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Transport } from '../types.js';
import type { VoiceConfig } from '../../types.js';
import { VoiceToolRouter, type HermesConversationReader } from './tools.js';
import { RealtimeBridge, type ClientSecretResult, type RealtimeBridgeOptions } from './realtime-bridge.js';
import { VOICE_REALTIME_MODEL, VOICE_MAX_CALL_ID_LENGTH } from './constants.js';
import { VoiceSessionController, type VoiceSessionContext, type VoiceSessionStatus } from './session.js';

const ORPHAN_HANGUP_ATTEMPTS = 2;
const ORPHAN_HANGUP_RETRY_DELAY_MS = 100;
const ATTACH_TOKEN_TTL_MS = 120_000;

type VoiceHealth = { voice: boolean; sideband: boolean; socket: boolean; context: boolean };

export interface VoiceTerminationStatus {
  sessionId: string | null;
  epoch: number | null;
  state: VoiceSessionStatus['state'];
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
 * Owns admission, sideband attachment, read-only tools, and idempotent cleanup.
 * The transport intentionally has no dependency on the general web mutation
 * surface; Hermes context arrives only through HermesConversationReader.
 */
export class VoiceTransport implements Transport {
  readonly name = 'voice';

  private readonly config: VoiceConfig;
  private readonly bridge: RealtimeBridge;
  private readonly router: VoiceToolRouter;
  private readonly sessions: VoiceSessionController;
  private readonly contextReader: HermesConversationReader;
  private started = false;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private socketHealthy: () => boolean = () => false;
  private onHangup: ((status: VoiceTerminationStatus) => void) | null = null;
  private terminating: Promise<VoiceTerminationStatus> | null = null;
  private readonly completedTerminations = new Map<string, VoiceTerminationStatus>();
  private readonly completedOwners = new Map<string, string>();
  private readonly orphanHangups = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attachGrants = new Map<string, AttachGrant>();
  private contextAvailable = false;

  /**
   * @param providerOptions Transport seams for the provider connection. Tests
   * inject a fetch/WebSocket double here so the lifecycle can be exercised
   * without a real Realtime call. The model is never injectable — it is pinned
   * to VOICE_REALTIME_MODEL.
   */
  constructor(
    config: VoiceConfig,
    dataDir: string,
    contextReader: HermesConversationReader,
    providerOptions: RealtimeBridgeOptions = {},
  ) {
    this.config = config;
    this.contextReader = {
      readConversation: async (limits) => {
        const result = await contextReader.readConversation(limits);
        this.contextAvailable = result.kind === 'available';
        return result;
      },
    };
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

    const deps = {
      contextReader: this.contextReader,
      terminateVoice: async (context: VoiceSessionContext) => this.terminate(context.sessionId, context.epoch, 'tool_disconnect'),
    };
    this.router = new VoiceToolRouter(deps, {
      accepts: (context) => this.sessions.canUseTools(context),
      live: (context) => this.sessions.accept(context),
    });
    this.bridge = new RealtimeBridge(config, this.router, {
      accepts: (context) => this.sessions.accept(context),
      userTurn: (context) => { this.sessions.touch(context); },
      providerFailure: (context, reason) => { void this.terminate(context.sessionId, context.epoch, reason); },
      reportSpend: (context, cents, source) => this.sessions.reportSpend(context, cents, source),
    }, providerOptions);
  }

  get currentOwner(): string | null {
    return this.sessions.currentOwner();
  }

  private ownerFor(owner: string | undefined): string {
    return owner ?? 'local';
  }

  private assertOwner(owner: string | undefined, sessionId?: string, epoch?: number): void {
    if (owner === undefined) return;
    const currentOwner = this.sessions.currentOwner();
    const completedOwner = sessionId && epoch ? this.completedOwners.get(`${sessionId}:${epoch}`) : undefined;
    if ((currentOwner ?? completedOwner) !== owner) {
      throw Object.assign(new Error('unauthorized'), { statusCode: 403 });
    }
  }

  private sweepAttachGrants(): void {
    const now = Date.now();
    for (const [key, grant] of this.attachGrants) {
      if (grant.expiresAt <= now) this.attachGrants.delete(key);
    }
  }

  async mintClientSecret(accountKey: string): Promise<ClientSecretResult & { sessionId: string; epoch: number; attachToken: string }> {
    const admitted = this.sessions.admit(accountKey);
    if (!admitted.ok || !admitted.context) throw new Error(admitted.error ?? 'voice admission denied');
    const context = admitted.context;
    const owner = this.ownerFor(accountKey === 'local' ? undefined : accountKey);
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
      const secret = await this.bridge.mintClientSecret(accountKey);
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
    if (this.terminating) return this.terminating;

    const context = this.sessions.currentContext();
    if (!context || context.sessionId !== sessionId || context.epoch !== epoch) {
      const status = this.sessions.status();
      return { sessionId: status.sessionId, epoch: status.epoch, state: status.state, providerHangupConfirmed: false, reason: 'stale_session' };
    }
    if (!this.sessions.beginTermination(context).accepted) {
      const status = this.sessions.status();
      return { sessionId, epoch, state: status.state, providerHangupConfirmed: status.state === 'terminated', reason };
    }

    this.terminating = (async () => {
      this.attachGrants.delete(key);
      const callId = this.bridge.detach(context);
      const providerFailed = reason.startsWith('provider_') || reason.startsWith('sideband_');
      const providerHangupConfirmed = callId ? await this.bridge.hangup(callId) : true;
      const state = this.sessions.finishTermination(context, providerHangupConfirmed && !providerFailed).state;
      const result: VoiceTerminationStatus = {
        sessionId,
        epoch,
        state,
        providerHangupConfirmed: providerHangupConfirmed && !providerFailed,
        reason,
      };
      this.completedTerminations.set(key, result);
      this.completedOwners.set(key, this.ownerFor(owner ?? this.sessions.currentOwner() ?? undefined));
      if (this.completedTerminations.size > 16) {
        const oldest = this.completedTerminations.keys().next().value;
        if (oldest) {
          this.completedTerminations.delete(oldest);
          this.completedOwners.delete(oldest);
        }
      }
      this.onHangup?.(result);
      if (callId && !providerHangupConfirmed) this.reapOrphanHangup(callId, result);
      return result;
    })();
    try {
      return await this.terminating;
    } finally {
      this.terminating = null;
    }
  }

  heartbeat(sessionId: string, epoch: number, owner?: string): boolean {
    if (owner !== undefined && this.sessions.currentOwner() !== owner) return false;
    return this.sessions.heartbeat(sessionId, epoch);
  }

  setSocketHealthProvider(provider: () => boolean): void {
    this.socketHealthy = provider;
  }

  setHangupHandler(handler: (status: VoiceTerminationStatus) => void): void {
    this.onHangup = handler;
  }

  statusFor(owner?: string): ReturnType<VoiceTransport['_status']> | null {
    if (owner !== undefined && this.sessions.currentOwner() !== null && this.sessions.currentOwner() !== owner) return null;
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
    contextAvailable: boolean;
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
      contextAvailable: this.contextAvailable,
      health: {
        voice: !!context && this.sessions.canUseTools(context),
        sideband: !!context && this.bridge.connectedFor(context),
        socket: this.socketHealthy(),
        context: this.contextAvailable,
      },
      budget: session.budget,
    };
  }

  private reapOrphanHangup(callId: string, result: VoiceTerminationStatus): void {
    if (this.orphanHangups.has(callId)) return;
    let attempts = 0;
    const retry = async (): Promise<void> => {
      attempts++;
      const confirmed = await this.bridge.hangup(callId).catch(() => false);
      if (confirmed) {
        this.orphanHangups.delete(callId);
        result.providerHangupConfirmed = true;
        this.onHangup?.(result);
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

  async start(): Promise<void> {
    this.started = true;
    this.reaper = setInterval(() => {
      for (const expired of this.sessions.reap()) {
        void this.terminate(expired.context.sessionId, expired.context.epoch, expired.reason);
      }
    }, Math.min(this.config.sessionLeaseMs, 5_000));
    console.log(`[voice] Transport ready (model: ${VOICE_REALTIME_MODEL}, voice: ${this.config.voice})`);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    const context = this.sessions.currentContext();
    if (context) await this.terminate(context.sessionId, context.epoch, 'transport_stop');
    for (const timer of this.orphanHangups.values()) clearTimeout(timer);
    this.orphanHangups.clear();
    this.attachGrants.clear();
    console.log('[voice] Transport stopped');
  }
}
