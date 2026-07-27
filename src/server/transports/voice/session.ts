import { createHash, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export type VoiceSessionState = 'idle' | 'admitting' | 'active' | 'terminating' | 'terminated' | 'failed';
export type VoiceBudgetState = 'ok' | 'budget_draining' | 'hard_exceeded';

export interface VoiceSessionContext {
  sessionId: string;
  epoch: number;
  leaseId: string;
}

export interface VoiceSessionOptions {
  dataPath: string;
  priceVersion: string;
  unitPriceCentsPerMinute: number;
  dailyCapCents: number;
  perSessionCapCents: number;
  absoluteSessionMs: number;
  idleMs: number;
  idleGraceMs: number;
  leaseMs: number;
}

export type VoiceIdleStatus = 'user_active' | 'idle_grace' | 'idle_expired';

export interface VoiceBudgetStatus {
  state: VoiceBudgetState;
  estimatedCents: number;
  reportedCents: number | null;
  remainingCents: number;
  reservationCents: number;
  dailyTotalCents: number;
  spendSource: 'estimated' | 'reported';
}

export interface VoiceSessionStatus {
  sessionId: string | null;
  epoch: number | null;
  state: VoiceSessionState;
  leaseExpiresAt: number | null;
  createdAt: number | null;
  lastActivityAt: number | null;
  idleStatus: VoiceIdleStatus;
  budget: VoiceBudgetStatus;
}

interface UsageReservation {
  accountKey: string;
  day: string;
  amountCents: number;
  expiresAt: number;
}

interface UsageFile {
  version: 1;
  accounts: Record<string, { dailyTotalCents: Record<string, number> }>;
  reservations: Record<string, UsageReservation>;
}

interface LiveSession {
  context: VoiceSessionContext;
  accountKey: string;
  reservationCents: number;
  createdAt: number;
  activeAt: number | null;
  lastActivityAt: number;
  leaseExpiresAt: number;
  state: VoiceSessionState;
  estimatedUsageCents: number | null;
  reportedCents: number | null;
}

function emptyUsage(): UsageFile {
  return { version: 1, accounts: {}, reservations: {} };
}

function accountHash(accountKey: string): string {
  return createHash('sha256').update(accountKey).digest('hex');
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Minimal durable ledger. Reservations are made before admission and settled
 * on termination, so a restart cannot silently forget an active session cap.
 */
export class VoiceUsageLedger {
  constructor(private readonly dataPath: string) {}

  reserve(sessionId: string, accountKey: string, now: number, amountCents: number, dailyCapCents: number, expiresAt: number): void {
    const data = this.read(now);
    const key = accountHash(accountKey);
    const day = utcDay(now);
    const account = data.accounts[key] ?? { dailyTotalCents: {} };
    const total = account.dailyTotalCents[day] ?? 0;
    const reserved = Object.values(data.reservations)
      .filter(r => r.accountKey === key && r.day === day)
      .reduce((sum, r) => sum + r.amountCents, 0);
    if (total + reserved + amountCents > dailyCapCents) {
      throw new Error('daily budget reservation unavailable');
    }
    data.accounts[key] = account;
    data.reservations[sessionId] = { accountKey: key, day, amountCents, expiresAt };
    this.write(data);
  }

  settle(sessionId: string, now: number, spendCents: number): void {
    const data = this.read(now);
    const reservation = data.reservations[sessionId];
    if (!reservation) return;
    const account = data.accounts[reservation.accountKey] ?? { dailyTotalCents: {} };
    account.dailyTotalCents[reservation.day] = (account.dailyTotalCents[reservation.day] ?? 0) + Math.min(reservation.amountCents, spendCents);
    data.accounts[reservation.accountKey] = account;
    delete data.reservations[sessionId];
    this.write(data);
  }

  dailyTotal(accountKey: string, now: number): number {
    const data = this.read(now);
    return data.accounts[accountHash(accountKey)]?.dailyTotalCents[utcDay(now)] ?? 0;
  }

  private read(now: number): UsageFile {
    let data = emptyUsage();
    try {
      const parsed = JSON.parse(readFileSync(this.dataPath, 'utf-8')) as UsageFile;
      if (parsed?.version !== 1 || !parsed.accounts || !parsed.reservations) {
        throw new Error('invalid voice usage ledger');
      }
      data = parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new Error('voice usage ledger unreadable');
    }
    let changed = false;
    for (const [id, reservation] of Object.entries(data.reservations)) {
      if (reservation.expiresAt <= now) {
        delete data.reservations[id];
        changed = true;
      }
    }
    if (changed) this.write(data);
    return data;
  }

  private write(data: UsageFile): void {
    try {
      mkdirSync(dirname(this.dataPath), { recursive: true });
      const tmp = `${this.dataPath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, this.dataPath);
    } catch {
      throw new Error('voice usage ledger write failed');
    }
  }
}

export class VoiceSessionController {
  private readonly ledger: VoiceUsageLedger;
  private session: LiveSession | null = null;
  private nextEpoch = 0;

  constructor(private readonly options: VoiceSessionOptions, private readonly now: () => number = Date.now) {
    this.ledger = new VoiceUsageLedger(options.dataPath);
  }

  admit(accountKey: string): { ok: boolean; context?: VoiceSessionContext; error?: string } {
    if (!this.hasKnownPricing()) return { ok: false, error: 'known versioned pricing is required for voice admission' };
    if (this.session && !this.isTerminal(this.session.state)) return { ok: false, error: 'voice session already live' };

    const now = this.now();
    const context: VoiceSessionContext = {
      sessionId: randomUUID(),
      epoch: ++this.nextEpoch,
      leaseId: randomUUID(),
    };
    try {
      this.ledger.reserve(
        context.sessionId,
        accountKey,
        now,
        this.options.perSessionCapCents,
        this.options.dailyCapCents,
        // Keep the reservation through the billing day if this process dies
        // before the reaper can settle it; the next day has a separate cap.
        now + this.options.absoluteSessionMs + 24 * 60 * 60_000
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'voice budget reservation failed' };
    }

    this.session = {
      context,
      accountKey,
      reservationCents: this.options.perSessionCapCents,
      createdAt: now,
      activeAt: null,
      lastActivityAt: now,
      leaseExpiresAt: Math.min(now + this.options.leaseMs, now + this.options.absoluteSessionMs),
      state: 'admitting',
      estimatedUsageCents: null,
      reportedCents: null,
    };
    return { ok: true, context };
  }

  activate(context: VoiceSessionContext): boolean {
    if (!this.matches(context) || this.session!.state !== 'admitting' || this.isExpired(this.session!)) return false;
    const now = this.now();
    this.session!.state = 'active';
    this.session!.activeAt = now;
    this.session!.lastActivityAt = now;
    this.extendLease(this.session!, now);
    return true;
  }

  /** Accepts only current active sideband/provider/tool events. */
  accept(context: VoiceSessionContext): boolean {
    return this.matches(context) && this.session!.state === 'active' && !this.isExpired(this.session!) && this.budget(this.session!).state !== 'hard_exceeded';
  }

  /** New tools/turns stop before the hard cap so read-only status can remain available. */
  canUseTools(context: VoiceSessionContext): boolean {
    return this.accept(context) && this.budget(this.session!).state === 'ok';
  }

  currentContext(): VoiceSessionContext | null {
    return this.session ? { ...this.session.context } : null;
  }

  /** The account key bound to the live session, or null if idle/terminated. */
  currentOwner(): string | null {
    if (!this.session || this.isTerminal(this.session.state)) return null;
    return this.session.accountKey;
  }

  heartbeat(sessionId: string, epoch: number): boolean {
    const session = this.session;
    if (!session || session.context.sessionId !== sessionId || session.context.epoch !== epoch || session.state !== 'active' || this.isExpired(session)) return false;
    this.extendLease(session, this.now());
    return true;
  }

  /** Explicit user turns and completed operations, not monitor ticks, refresh idleness. */
  touch(context: VoiceSessionContext): boolean {
    if (!this.canUseTools(context)) return false;
    const now = this.now();
    this.session!.lastActivityAt = now;
    this.extendLease(this.session!, now);
    return true;
  }

  reportSpend(context: VoiceSessionContext, cents: number, source: 'estimated' | 'reported' = 'reported'): boolean {
    if (!this.matches(context) || !Number.isFinite(cents) || cents < 0) return false;
    if (source === 'reported') this.session!.reportedCents = Math.ceil(cents);
    else this.session!.estimatedUsageCents = Math.max(this.session!.estimatedUsageCents ?? 0, Math.ceil(cents));
    return true;
  }

  beginTermination(context: VoiceSessionContext): { accepted: boolean; state: VoiceSessionState } {
    if (!this.matches(context)) return { accepted: false, state: this.session?.state ?? 'idle' };
    if (this.isTerminal(this.session!.state) || this.session!.state === 'terminating') return { accepted: false, state: this.session!.state };
    this.session!.state = 'terminating';
    return { accepted: true, state: 'terminating' };
  }

  finishTermination(context: VoiceSessionContext, providerConfirmed: boolean): VoiceSessionStatus {
    if (!this.matches(context)) return this.status();
    const session = this.session!;
    const spend = session.reportedCents ?? this.estimateCents(session);
    try {
      this.ledger.settle(session.context.sessionId, this.now(), spend);
    } catch {
      providerConfirmed = false;
    }
    session.state = providerConfirmed ? 'terminated' : 'failed';
    return this.status();
  }

  /** Returns sessions needing the transport's authoritative terminate path. */
  reap(): Array<{ context: VoiceSessionContext; reason: 'lease_expired' | 'idle_timeout' | 'hard_exceeded' }> {
    const session = this.session;
    if (!session || this.isTerminal(session.state) || session.state === 'terminating') return [];
    const budget = this.budget(session);
    if (budget.state === 'hard_exceeded') return [{ context: session.context, reason: 'hard_exceeded' }];
    const now = this.now();
    if (now - session.lastActivityAt >= this.options.idleMs + this.options.idleGraceMs) return [{ context: session.context, reason: 'idle_timeout' }];
    if (now >= session.leaseExpiresAt) return [{ context: session.context, reason: 'lease_expired' }];
    return [];
  }

  status(): VoiceSessionStatus {
    const session = this.session;
    if (!session) {
      return {
        sessionId: null,
        epoch: null,
        state: 'idle',
        leaseExpiresAt: null,
        createdAt: null,
        lastActivityAt: null,
        idleStatus: 'user_active',
        budget: { state: 'ok', estimatedCents: 0, reportedCents: null, remainingCents: this.options.dailyCapCents, reservationCents: 0, dailyTotalCents: 0, spendSource: 'estimated' },
      };
    }
    return {
      sessionId: session.context.sessionId,
      epoch: session.context.epoch,
      state: session.state,
      leaseExpiresAt: session.leaseExpiresAt,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      idleStatus: this.idleStatus(session),
      budget: this.budget(session),
    };
  }

  private budget(session: LiveSession): VoiceBudgetStatus {
    const estimatedCents = Math.max(this.estimateCents(session), session.estimatedUsageCents ?? 0);
    const reportedCents = session.reportedCents;
    const spentCents = Math.max(estimatedCents, reportedCents ?? 0);
    const dailyTotalCents = this.ledger.dailyTotal(session.accountKey, this.now());
    const remainingCents = Math.max(0, Math.min(
      session.reservationCents - spentCents,
      this.options.dailyCapCents - dailyTotalCents - spentCents
    ));
    const state: VoiceBudgetState = spentCents >= session.reservationCents || this.now() - session.createdAt >= this.options.absoluteSessionMs
      ? 'hard_exceeded'
      : remainingCents <= this.options.unitPriceCentsPerMinute
        ? 'budget_draining'
        : 'ok';
    const spendSource: 'estimated' | 'reported' = reportedCents !== null ? 'reported' : 'estimated';
    return { state, estimatedCents, reportedCents, remainingCents, reservationCents: session.reservationCents, dailyTotalCents, spendSource };
  }

  private estimateCents(session: LiveSession): number {
    const startedAt = session.activeAt ?? session.createdAt;
    const elapsedMs = Math.max(0, this.now() - startedAt);
    return Math.min(session.reservationCents, Math.ceil(elapsedMs * this.options.unitPriceCentsPerMinute / 60_000));
  }

  private matches(context: VoiceSessionContext): boolean {
    const current = this.session?.context;
    return current?.sessionId === context.sessionId && current.epoch === context.epoch && current.leaseId === context.leaseId;
  }

  private extendLease(session: LiveSession, now: number): void {
    session.leaseExpiresAt = Math.min(session.createdAt + this.options.absoluteSessionMs, now + this.options.leaseMs);
  }

  private isExpired(session: LiveSession): boolean {
    return this.now() >= session.leaseExpiresAt || this.now() - session.lastActivityAt >= this.options.idleMs + this.options.idleGraceMs || this.budget(session).state === 'hard_exceeded';
  }

  private idleStatus(session: LiveSession): VoiceIdleStatus {
    if (this.budget(session).state === 'hard_exceeded') return 'idle_expired';
    const elapsed = this.now() - session.lastActivityAt;
    const idleThreshold = this.options.idleMs + this.options.idleGraceMs;
    if (elapsed < this.options.idleMs) return 'user_active';
    if (elapsed < idleThreshold) return 'idle_grace';
    return 'idle_expired';
  }

  private hasKnownPricing(): boolean {
    return this.options.priceVersion.trim().length > 0 && Number.isFinite(this.options.unitPriceCentsPerMinute) && this.options.unitPriceCentsPerMinute > 0;
  }

  private isTerminal(state: VoiceSessionState): boolean {
    return state === 'terminated' || state === 'failed';
  }
}
