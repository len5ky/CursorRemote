import { randomUUID } from 'crypto';
import { join } from 'path';
import type { Transport } from '../types.js';
import type { VoiceConfig, CursorState } from '../../types.js';
import type { StateManager } from '../../state-manager.js';
import type { CommandExecutor } from '../../command-executor.js';
import type { CDPBridge } from '../../cdp-bridge.js';
import type { WindowMonitor, WindowSnapshot } from '../../window-monitor.js';
import { cleanTabTitle } from '../../dom-extractor.js';
import { VoiceToolRouter, type VoiceToolDeps, type SessionSummary, type PinnedVoiceTarget } from './tools.js';
import { RealtimeBridge, type ClientSecretResult } from './realtime-bridge.js';
import { DigestClient } from './digest.js';
import { VoiceSessionController, type VoiceSessionContext, type VoiceSessionStatus } from './session.js';

export interface VoiceTerminationStatus {
  sessionId: string | null;
  epoch: number | null;
  state: VoiceSessionStatus['state'];
  providerConfirmed: boolean;
  reason: string;
}

/**
 * VoiceTransport — DICKTATOR ("you dictate; they obey"), aka car mode.
 * Mirrors TelegramTransport's structure:
 * subscribes to StateManager patches and pushes proactive events (new pending
 * approval, agent blocked) into the live Realtime session, rate-limited.
 *
 * The relay exposes two endpoints backed by this transport:
 *   POST /api/voice/token  → mint ephemeral client secret (browser → WebRTC)
 *   POST /api/voice/call   → { callId } attach server sideband for tool calls
 */
export class VoiceTransport implements Transport {
  readonly name = 'voice';

  private config: VoiceConfig;
  private stateManager: StateManager;
  private bridge: RealtimeBridge;
  private router: VoiceToolRouter;
  private windowMonitor: WindowMonitor;
  private sessions: VoiceSessionController;
  private started = false;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private socketHealthy: () => boolean = () => false;
  private onHangup: ((status: VoiceTerminationStatus) => void) | null = null;
  private terminating: Promise<VoiceTerminationStatus> | null = null;
  private readonly completedTerminations = new Map<string, VoiceTerminationStatus>();

  private lastAnnounceAt = 0;
  private announcedApprovalIds = new Set<string>();
  private lastAgentStatus: string | null = null;
  /** Latest per-window snapshots so list_sessions can cover non-active windows. */
  private snapshots = new Map<string, WindowSnapshot>();

  constructor(
    config: VoiceConfig,
    dataDir: string,
    windowMonitor: WindowMonitor,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.windowMonitor = windowMonitor;
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

    const digestClient = new DigestClient({
      apiKey: config.openrouterApiKey,
      model: config.digestModel,
    });

const deps: VoiceToolDeps = {
      getState: () => stateManager.getCurrentState(),
      listSessions: (): SessionSummary[] => {
        const state = stateManager.getCurrentState();
        return state.windows.map(w => {
          const snap = this.snapshots.get(w.id);
          const tabs = w.id === state.activeWindowId
          ? state.chatTabs
          : (snap?.chatTabs ?? []);
          return {
            windowId: w.id,
            windowTitle: w.title,
            tabs: tabs.map(t => ({
              title: cleanTabTitle(t.title),
              isActive: t.isActive,
              status: t.status,
            })),
          };
        });
      },
      activateTarget: async (windowId, tabTitle) => {
        const state = stateManager.getCurrentState();
        if (state.activeWindowId !== windowId) {
          await cdpBridge.switchWindow(windowId);
        }
        if (tabTitle) {
          const active = stateManager.getCurrentState().chatTabs.find(t => t.isActive);
          if (!active || cleanTabTitle(active.title) !== tabTitle) {
            await commandExecutor.switchTab(randomUUID(), tabTitle);
          }
        }
      },
      sendMessage: async (text, target) => {
        const current = this.currentPinnedTarget();
        if (target && current) {
          if (target.windowId !== current.windowId || target.composerId !== current.composerId || target.revision !== current.revision) {
            throw new Error('Pinned target changed. Stage the action again.');
          }
        }
        const r = await commandExecutor.sendMessage(randomUUID(), text);
        if (!r.ok) throw new Error(r.error ?? 'send failed');
      },
      clickApproval: async (selectorPath, target) => {
        const current = this.currentPinnedTarget();
        if (target && current) {
          if (target.windowId !== current.windowId || target.composerId !== current.composerId || target.revision !== current.revision) {
            throw new Error('Pinned target changed. Stage the action again.');
          }
        }
        const r = await commandExecutor.clickApproval(randomUUID(), selectorPath);
        if (!r.ok) throw new Error(r.error ?? 'approval click failed');
      },
      clickAction: async (selectorPath, label, target) => {
        const current = this.currentPinnedTarget();
        if (target && current) {
          if (target.windowId !== current.windowId || target.composerId !== current.composerId || target.revision !== current.revision) {
            throw new Error('Pinned target changed. Stage the action again.');
          }
        }
        const r = await commandExecutor.clickAction(randomUUID(), selectorPath, label);
        if (!r.ok) throw new Error(r.error ?? 'action click failed');
      },
      setMode: async (modeId, target) => {
        const current = this.currentPinnedTarget();
        if (target && current) {
          if (target.windowId !== current.windowId || target.composerId !== current.composerId || target.revision !== current.revision) {
            throw new Error('Pinned target changed. Stage the action again.');
          }
        }
        const r = await commandExecutor.setMode(randomUUID(), modeId);
        if (!r.ok) throw new Error(r.error ?? 'set mode failed');
      },
      setModel: async (modelId, target) => {
        const current = this.currentPinnedTarget();
        if (target && current) {
          if (target.windowId !== current.windowId || target.composerId !== current.composerId || target.revision !== current.revision) {
            throw new Error('Pinned target changed. Stage the action again.');
          }
        }
        const r = await commandExecutor.setModel(randomUUID(), modelId);
        if (!r.ok) throw new Error(r.error ?? 'set model failed');
      },
      digest: (messages, state) => digestClient.digest(messages, state),
      getPinnedTarget: () => this.currentPinnedTarget(),
      terminateVoice: async (context) => this.terminate(context.sessionId, context.epoch, 'tool_disconnect'),
      revalidateTarget: (expected) => {
        const current = this.currentPinnedTarget();
        return !!current
          && current.windowId === expected.windowId
          && current.composerId === expected.composerId
          && current.revision === expected.revision;
      },
    };

    this.router = new VoiceToolRouter(deps, {
      accepts: (context) => this.sessions.canUseTools(context),
      live: (context) => this.sessions.accept(context),
      mutationHealth: (context, target) => this.mutationHealth(context, target),
      committed: (context) => { this.sessions.touch(context); },
    });
    this.bridge = new RealtimeBridge(config, this.router, {
      accepts: (context) => this.sessions.accept(context),
      userTurn: (context) => { this.sessions.touch(context); },
      providerFailure: (context, reason) => { void this.terminate(context.sessionId, context.epoch, reason); },
      reportSpend: (context, cents, source) => this.sessions.reportSpend(context, cents, source),
    });
  }

  // --- relay-facing API ---

  /** The session owner account key (session token), or null when idle/terminated. */
  get currentOwner(): string | null {
    return this.sessions.currentOwner();
  }

  /** Throw a non-disclosing 403 when `owner` is provided but doesn't match the session owner. */
  private assertOwner(owner: string | undefined): void {
    if (owner !== undefined) {
      const sessionOwner = this.sessions.currentOwner();
      if (sessionOwner === null || sessionOwner !== owner) {
        throw Object.assign(new Error('unauthorized'), { statusCode: 403 });
      }
    }
  }

  async mintClientSecret(accountKey: string): Promise<ClientSecretResult & { sessionId: string; epoch: number }> {
    const admitted = this.sessions.admit(accountKey);
    if (!admitted.ok || !admitted.context) throw new Error(admitted.error ?? 'voice admission denied');
    try {
      const secret = await this.bridge.mintClientSecret();
      return { ...secret, sessionId: admitted.context.sessionId, epoch: admitted.context.epoch };
    } catch (err) {
      await this.terminate(admitted.context.sessionId, admitted.context.epoch, 'provider_admission_failed');
      throw err;
    }
  }

  async attachCall(callId: string, ephemeralKey: string | undefined, sessionId: string, epoch: number, owner?: string): Promise<void> {
    this.assertOwner(owner);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(callId)) throw new Error('invalid call id');
    const context = this.sessions.currentContext();
    if (!context || context.sessionId !== sessionId || context.epoch !== epoch || !this.sessions.activate(context)) {
      throw new Error('voice session is no longer admitting');
    }
    try {
      await this.bridge.attachSideband(callId, ephemeralKey, context);
    } catch (err) {
      await this.terminate(sessionId, epoch, 'sideband_attach_failed');
      throw err;
    }
  }

  async terminate(sessionId: string, epoch: number, reason = 'client_request', owner?: string): Promise<VoiceTerminationStatus> {
    this.assertOwner(owner);
    const key = `${sessionId}:${epoch}`;
    const completed = this.completedTerminations.get(key);
    if (completed) return completed;
    if (this.terminating) return this.terminating;

    const context = this.sessions.currentContext();
    if (!context || context.sessionId !== sessionId || context.epoch !== epoch) {
      const status = this.sessions.status();
      return { sessionId: status.sessionId, epoch: status.epoch, state: status.state, providerConfirmed: false, reason: 'stale_session' };
    }
    if (!this.sessions.beginTermination(context).accepted) {
      const status = this.sessions.status();
      return { sessionId, epoch, state: status.state, providerConfirmed: status.state === 'terminated', reason };
    }

    this.terminating = (async () => {
      this.router.revokeAuthority();
      const callId = this.bridge.detach(context);
      const providerFailed = reason.startsWith('provider_') || reason.startsWith('sideband_');
      const providerConfirmed = callId ? await this.bridge.hangup(callId) : true;
      const state = this.sessions.finishTermination(context, providerConfirmed && !providerFailed).state;
      const result: VoiceTerminationStatus = { sessionId, epoch, state, providerConfirmed: providerConfirmed && !providerFailed, reason };
      this.completedTerminations.set(key, result);
      if (this.completedTerminations.size > 16) this.completedTerminations.delete(this.completedTerminations.keys().next().value!);
      this.onHangup?.(result);
      return result;
    })();
    try {
      return await this.terminating;
    } finally {
      this.terminating = null;
    }
  }

  heartbeat(sessionId: string, epoch: number, owner?: string): boolean {
    if (owner !== undefined) {
      const sessionOwner = this.sessions.currentOwner();
      if (sessionOwner === null || sessionOwner !== owner) return false;
    }
    return this.sessions.heartbeat(sessionId, epoch);
  }

  setSocketHealthProvider(provider: () => boolean): void {
    this.socketHealthy = provider;
  }

  setHangupHandler(handler: (status: VoiceTerminationStatus) => void): void {
    this.onHangup = handler;
  }

  /** Full session status — returns null (non-disclosing) when owner doesn't match. */
  statusFor(owner?: string): {
    connected: boolean;
    sessionId: string | null;
    epoch: number | null;
    state: VoiceSessionStatus['state'];
    target: PinnedVoiceTarget | null;
    health: { voice: boolean; sideband: boolean; socket: boolean; cdp: boolean; target: boolean };
    budget: VoiceSessionStatus['budget'];
  } | null {
    if (owner !== undefined) {
      const sessionOwner = this.sessions.currentOwner();
      if (sessionOwner !== null && sessionOwner !== owner) return null;
    }
    return this._status();
  }

  get status(): {
    connected: boolean;
    sessionId: string | null;
    epoch: number | null;
    state: VoiceSessionStatus['state'];
    target: PinnedVoiceTarget | null;
    health: { voice: boolean; sideband: boolean; socket: boolean; cdp: boolean; target: boolean };
    budget: VoiceSessionStatus['budget'];
  } {
    return this._status();
  }

  private _status(): {
    connected: boolean;
    sessionId: string | null;
    epoch: number | null;
    state: VoiceSessionStatus['state'];
    target: PinnedVoiceTarget | null;
    health: { voice: boolean; sideband: boolean; socket: boolean; cdp: boolean; target: boolean };
    budget: VoiceSessionStatus['budget'];
  } {
    const session = this.sessions.status();
    const context = this.sessions.currentContext();
    const target = this.router.currentTarget.target ?? null;
    const current = this.currentPinnedTarget();
    const cdp = this.cdpHealthy();
    const exactTarget = !!target && !!current && target.windowId === current.windowId && target.composerId === current.composerId && target.revision === current.revision;
    return {
      connected: !!context && this.bridge.connectedFor(context),
      sessionId: session.sessionId,
      epoch: session.epoch,
      state: session.state,
      target,
      health: {
        voice: !!context && this.sessions.canUseTools(context),
        sideband: !!context && this.bridge.connectedFor(context),
        socket: this.socketHealthy(),
        cdp,
        target: exactTarget,
      },
      budget: session.budget,
    };
  }

  private currentPinnedTarget(): PinnedVoiceTarget | null {
    const state = this.stateManager.getCurrentState();
    if (!state.activeWindowId || !state.activeComposerId || !this.cdpHealthy()) return null;
    return {
      windowId: state.activeWindowId,
      composerId: state.activeComposerId,
      revision: `${this.stateManager.generation}:${state.activeWindowId}:${state.activeComposerId}`,
      ageMs: Math.max(0, Date.now() - (state.lastExtractionAt ?? 0)),
    };
  }

  private cdpHealthy(): boolean {
    const state = this.stateManager.getCurrentState();
    return state.connected && state.extractorStatus === 'ok' && state.lastExtractionAt !== null && Date.now() - state.lastExtractionAt <= this.config.targetMaxAgeMs;
  }

  private mutationHealth(context: VoiceSessionContext, target: PinnedVoiceTarget): { ok: boolean; reason?: string } {
    const current = this.currentPinnedTarget();
    if (!this.sessions.canUseTools(context)) return { ok: false, reason: 'Voice budget or lease is no longer healthy.' };
    if (!this.bridge.connectedFor(context)) return { ok: false, reason: 'Voice sideband is disconnected.' };
    if (!this.socketHealthy()) return { ok: false, reason: 'Authenticated relay socket is disconnected.' };
    if (!this.cdpHealthy()) return { ok: false, reason: 'Cursor CDP health is stale.' };
    if (!current || current.windowId !== target.windowId || current.composerId !== target.composerId || current.revision !== target.revision) {
      return { ok: false, reason: 'Pinned Cursor target changed. Stage the action again.' };
    }
    return { ok: true };
  }

  // --- Transport lifecycle ---

  async start(): Promise<void> {
    this.started = true;
    this.stateManager.on('state:patch', this.onStatePatch);
    this.windowMonitor.on('window:update', this.onWindowUpdate);
    this.reaper = setInterval(() => {
      for (const expired of this.sessions.reap()) {
        void this.terminate(expired.context.sessionId, expired.context.epoch, expired.reason);
      }
    }, Math.min(this.config.sessionLeaseMs, 5_000));
    console.log(`[dicktator] Voice transport ready (model: ${this.config.model}, voice: ${this.config.voice})`);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stateManager.off('state:patch', this.onStatePatch);
    this.windowMonitor.off('window:update', this.onWindowUpdate);
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    const context = this.sessions.currentContext();
    if (context) await this.terminate(context.sessionId, context.epoch, 'transport_stop');
    console.log('[dicktator] Voice transport stopped');
  }

  // --- proactive events ---

  private onWindowUpdate = (windowId: string, snapshot: WindowSnapshot): void => {
    this.snapshots.set(windowId, snapshot);
  };

  private onStatePatch = (patch: Partial<CursorState>): void => {
    const context = this.sessions.currentContext();
    if (!this.started || !context || !this.bridge.connectedFor(context) || !this.sessions.accept(context)) return;

    if (patch.pendingApprovals && patch.pendingApprovals.length > 0) {
      const fresh = patch.pendingApprovals.filter(a => !this.announcedApprovalIds.has(a.id));
      if (fresh.length > 0) {
        for (const a of fresh) this.announcedApprovalIds.add(a.id);
        // cap memory
        if (this.announcedApprovalIds.size > 200) {
          this.announcedApprovalIds = new Set([...this.announcedApprovalIds].slice(-100));
        }
        this.rateLimitedAnnounce(
          `The agent is waiting for approval: ${fresh[0].description.substring(0, 160)}`,
          context
        );
      }
    }

    if (typeof patch.agentStatus === 'string' && patch.agentStatus !== this.lastAgentStatus) {
      const prev = this.lastAgentStatus;
      this.lastAgentStatus = patch.agentStatus;
      if (patch.agentStatus === 'error') {
          this.rateLimitedAnnounce('The agent hit an error and may be blocked.', context);
      } else if (patch.agentStatus === 'idle' && prev && prev !== 'idle' && prev !== 'waiting_approval') {
          this.rateLimitedAnnounce('The agent finished and is now idle.', context);
      }
    }
  };

  private rateLimitedAnnounce(text: string, context: VoiceSessionContext): void {
    const now = Date.now();
    if (now - this.lastAnnounceAt < this.config.proactiveMinIntervalMs) return;
    this.lastAnnounceAt = now;
    this.bridge.announce(text, context);
  }
}
