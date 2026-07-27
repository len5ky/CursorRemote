import { randomUUID } from 'crypto';
import type { Transport } from '../types.js';
import type { VoiceConfig, CursorState } from '../../types.js';
import type { StateManager } from '../../state-manager.js';
import type { CommandExecutor } from '../../command-executor.js';
import type { CDPBridge } from '../../cdp-bridge.js';
import type { WindowMonitor, WindowSnapshot } from '../../window-monitor.js';
import { cleanTabTitle } from '../../dom-extractor.js';
import { VoiceToolRouter, type VoiceToolDeps, type SessionSummary } from './tools.js';
import { RealtimeBridge, type ClientSecretResult } from './realtime-bridge.js';
import { DigestClient } from './digest.js';

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
  private started = false;

  private lastAnnounceAt = 0;
  private announcedApprovalIds = new Set<string>();
  private lastAgentStatus: string | null = null;
  /** Latest per-window snapshots so list_sessions can cover non-active windows. */
  private snapshots = new Map<string, WindowSnapshot>();

  constructor(
    config: VoiceConfig,
    windowMonitor: WindowMonitor,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.windowMonitor = windowMonitor;

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
      sendMessage: async (text) => {
        const r = await commandExecutor.sendMessage(randomUUID(), text);
        if (!r.ok) throw new Error(r.error ?? 'send failed');
      },
      clickApproval: async (selectorPath) => {
        const r = await commandExecutor.clickApproval(randomUUID(), selectorPath);
        if (!r.ok) throw new Error(r.error ?? 'approval click failed');
      },
      clickAction: async (selectorPath, label) => {
        const r = await commandExecutor.clickAction(randomUUID(), selectorPath, label);
        if (!r.ok) throw new Error(r.error ?? 'action click failed');
      },
      setMode: async (modeId) => {
        const r = await commandExecutor.setMode(randomUUID(), modeId);
        if (!r.ok) throw new Error(r.error ?? 'set mode failed');
      },
      setModel: async (modelId) => {
        const r = await commandExecutor.setModel(randomUUID(), modelId);
        if (!r.ok) throw new Error(r.error ?? 'set model failed');
      },
      digest: (messages, state) => digestClient.digest(messages, state),
    };

    this.router = new VoiceToolRouter(deps);
    this.bridge = new RealtimeBridge(config, this.router);
  }

  // --- relay-facing API ---

  mintClientSecret(): Promise<ClientSecretResult> {
    return this.bridge.mintClientSecret();
  }

  attachCall(callId: string): Promise<void> {
    return this.bridge.attachSideband(callId);
  }

  detachCall(): void {
    this.bridge.detach();
  }

  get status(): { connected: boolean; target?: string } {
    const target = this.router.currentTarget;
    const state = this.stateManager.getCurrentState();
    const win = target.windowId
      ? state.windows.find(w => w.id === target.windowId)
      : undefined;
    return {
      connected: this.bridge.connected,
      target: win ? `${win.title}${target.tabTitle ? ` / ${target.tabTitle}` : ''}` : undefined,
    };
  }

  // --- Transport lifecycle ---

  async start(): Promise<void> {
    this.started = true;
    this.stateManager.on('state:patch', this.onStatePatch);
    this.windowMonitor.on('window:update', this.onWindowUpdate);
    console.log(`[dicktator] Voice transport ready (model: ${this.config.model}, voice: ${this.config.voice})`);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stateManager.off('state:patch', this.onStatePatch);
    this.windowMonitor.off('window:update', this.onWindowUpdate);
    this.bridge.detach();
    console.log('[dicktator] Voice transport stopped');
  }

  // --- proactive events ---

  private onWindowUpdate = (windowId: string, snapshot: WindowSnapshot): void => {
    this.snapshots.set(windowId, snapshot);
  };

  private onStatePatch = (patch: Partial<CursorState>): void => {
    if (!this.started || !this.bridge.connected) return;

    if (patch.pendingApprovals && patch.pendingApprovals.length > 0) {
      const fresh = patch.pendingApprovals.filter(a => !this.announcedApprovalIds.has(a.id));
      if (fresh.length > 0) {
        for (const a of fresh) this.announcedApprovalIds.add(a.id);
        // cap memory
        if (this.announcedApprovalIds.size > 200) {
          this.announcedApprovalIds = new Set([...this.announcedApprovalIds].slice(-100));
        }
        this.rateLimitedAnnounce(
          `The agent is waiting for approval: ${fresh[0].description.substring(0, 160)}`
        );
      }
    }

    if (typeof patch.agentStatus === 'string' && patch.agentStatus !== this.lastAgentStatus) {
      const prev = this.lastAgentStatus;
      this.lastAgentStatus = patch.agentStatus;
      if (patch.agentStatus === 'error') {
        this.rateLimitedAnnounce('The agent hit an error and may be blocked.');
      } else if (patch.agentStatus === 'idle' && prev && prev !== 'idle' && prev !== 'waiting_approval') {
        this.rateLimitedAnnounce('The agent finished and is now idle.');
      }
    }
  };

  private rateLimitedAnnounce(text: string): void {
    const now = Date.now();
    if (now - this.lastAnnounceAt < this.config.proactiveMinIntervalMs) return;
    this.lastAnnounceAt = now;
    this.bridge.announce(text);
  }
}
