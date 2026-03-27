import { EventEmitter } from 'events';
import { CdpClient } from './cdp-client.js';
import { extractWorkspaceName } from './cdp-bridge.js';
import type { CDPBridge } from './cdp-bridge.js';
import type { StateManager } from './state-manager.js';
import type { DOMExtractor } from './dom-extractor.js';
import type {
  ChatElement,
  Approval,
  AgentStatus,
  ChatTab,
  ComposerQueueState,
  CursorWindow,
  CursorState,
  ModeInfo,
  ModelInfo,
  ServerConfig,
  SelectorConfig,
} from './types.js';
import { applyDerivedActivityToState } from './activity-derive.js';

export interface WindowSnapshot {
  windowId: string;
  windowTitle: string;
  messages: ChatElement[];
  chatTabs: ChatTab[];
  pendingApprovals: Approval[];
  agentStatus: AgentStatus;
  agentActivityText: string | null;
  agentActivityLive: boolean;
  agentActivitySource: CursorState['agentActivitySource'];
  composerQueue: ComposerQueueState;
  mode: ModeInfo;
  model: ModelInfo;
  lastUpdated: number;
}

const CYCLE_INTERVAL_MS = 10000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Type-specific content key for a single element.
 * Returns a string that changes whenever the element's visible content changes.
 */
function elementContentKey(el: ChatElement): string {
  switch (el.type) {
    case 'assistant': return String(el.html?.length ?? el.text?.length ?? 0);
    case 'human': return String(el.text.length);
    case 'tool': return `${el.status}:${el.action}:${el.filename ?? ''}`;
    case 'run_command': return `${el.command.length}:${el.actions.length}`;
    case 'thought':
      return `${el.thoughtKind ?? ''}:${el.action ?? ''}:${el.detail ?? ''}:${el.duration ?? ''}`;
    case 'plan':
      return `${el.todosCompleted}/${el.todosTotal}:${(el.descriptionHtml || el.description || '').length}:${el.model ?? ''}`;
    case 'todo_list': return `${el.todosCompleted}/${el.todosTotal}`;
    case 'loading': return el.text ?? '';
  }
}

/**
 * Fingerprint of the last message including its type and content.
 * Detects streaming content changes and element type transitions
 * (e.g. tool -> run_command at the same data-message-id).
 */
function messageFingerprint(messages: ChatElement[]): string {
  if (messages.length === 0) return '';
  const last = messages[messages.length - 1];
  return `${messages.length}:${last.type}:${last.id}:${elementContentKey(last)}`;
}

/**
 * Lightweight signature over ALL elements' types, ids, and key state.
 * Catches mid-list changes (tool status transitions, plan progress, type
 * changes at non-tail positions) that the last-element fingerprint misses.
 */
function elementsSignature(messages: ChatElement[]): string {
  let sig = '';
  for (const m of messages) {
    sig += m.type[0] + m.id;
    if (m.type === 'tool') sig += m.status[0];
    else if (m.type === 'plan') {
      sig += m.todosCompleted + (m.descriptionHtml?.length ?? 0) + (m.title?.length ?? 0);
    }     else if (m.type === 'todo_list') sig += m.todosCompleted;
    else if (m.type === 'thought') sig += (m.duration || '') + (m.thoughtKind || '');
    else if (m.type === 'loading' && m.text) sig += m.text.length;
  }
  return sig;
}

/**
 * Monitors all Cursor windows using parallel CDP connections.
 * The "home" window is the one connected via the main CDPBridge (polled continuously).
 * Other windows get their own temporary CDP connections every CYCLE_INTERVAL_MS.
 * No window switching — the UI stays on the home window.
 */
export class WindowMonitor extends EventEmitter {
  private cdpBridge: CDPBridge;
  private stateManager: StateManager;
  private extractorFactory: () => DOMExtractor;
  private selectors: SelectorConfig;
  private config: ServerConfig;

  private snapshots = new Map<string, WindowSnapshot>();
  private homeWindowId: string | null = null;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private _cycling = false;
  private _firstCycleLogged = false;
  private switchGeneration = -1;

  get isCycling(): boolean {
    return this._cycling;
  }

  constructor(
    cdpBridge: CDPBridge,
    stateManager: StateManager,
    _extractor: DOMExtractor,
    config: ServerConfig,
    selectors?: SelectorConfig
  ) {
    super();
    this.cdpBridge = cdpBridge;
    this.stateManager = stateManager;
    this.config = config;
    this.selectors = selectors ?? {} as SelectorConfig;

    this.extractorFactory = () => {
      const { DOMExtractor: ExtClass } = require('./dom-extractor.js') as { DOMExtractor: typeof DOMExtractor };
      return new ExtClass(this.selectors, () => {});
    };
  }

  start(): void {
    this.stateManager.on('state:patch', this.onPatch);
    this.cdpBridge.on('connected', this.onConnected);

    this.cycleTimer = setInterval(() => this.cycle(), CYCLE_INTERVAL_MS);
    console.log(`[window-monitor] Started (parallel mode, cycle every ${CYCLE_INTERVAL_MS / 1000}s)`);
  }

  stop(): void {
    this.stateManager.off('state:patch', this.onPatch);
    this.cdpBridge.off('connected', this.onConnected);
    if (this.cycleTimer) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  setHomeWindow(windowId: string): void {
    if (this.homeWindowId !== windowId) {
      this.homeWindowId = windowId;
      this.switchGeneration = this.stateManager.generation;
    }
  }

  getHomeWindowId(): string {
    return this.homeWindowId ?? this.cdpBridge.activeTargetId;
  }

  getSnapshot(windowId: string): WindowSnapshot | undefined {
    return this.snapshots.get(windowId);
  }

  getAllSnapshots(): Map<string, WindowSnapshot> {
    return this.snapshots;
  }

  private onConnected = (): void => {
    const targetId = this.cdpBridge.activeTargetId;
    if (!this.homeWindowId) {
      this.homeWindowId = targetId;
    }
    // If we have a cached snapshot for this window, push its mode/model immediately
    // so the web/Telegram clients don't show stale values while waiting for extraction.
    const cached = targetId ? this.snapshots.get(targetId) : undefined;
    if (cached) {
      this.stateManager.updateModeModel(cached.mode, cached.model);
    }
    this.captureHomeWindow();
    // Run first cycle immediately so other windows are available for /sync
    setTimeout(() => this.cycle(), 2000);
  };

  private onPatch = (): void => {
    this.captureHomeWindow();
  };

  private captureHomeWindow(): void {
    const state = this.stateManager.getCurrentState();
    if (!state.connected) return;

    // After a window switch, wait for at least one fresh DOM extraction
    // before emitting snapshots. This prevents stale state from the old
    // window being attributed to the new window's title.
    if (this.stateManager.generation <= this.switchGeneration) return;

    const windowId = this.cdpBridge.activeTargetId;
    if (!windowId) return;

    const win = state.windows.find(w => w.id === windowId);
    if (!win) return;

    const snapshot: WindowSnapshot = {
      windowId,
      windowTitle: win.title,
      messages: state.messages,
      chatTabs: state.chatTabs,
      pendingApprovals: state.pendingApprovals,
      agentStatus: state.agentStatus,
      agentActivityText: state.agentActivityText,
      agentActivityLive: state.agentActivityLive,
      agentActivitySource: state.agentActivitySource,
      composerQueue: state.composerQueue,
      mode: state.mode,
      model: state.model,
      lastUpdated: Date.now(),
    };

    const prev = this.snapshots.get(windowId);
    const queueSig = JSON.stringify(snapshot.composerQueue);
    const prevQueueSig = prev ? JSON.stringify(prev.composerQueue) : '';
    const changed = !prev
      || prev.messages.length !== snapshot.messages.length
      || (prev.messages.length > 0 && prev.messages[prev.messages.length - 1]?.id !== snapshot.messages[snapshot.messages.length - 1]?.id)
      || prev.agentStatus !== snapshot.agentStatus
      || prev.agentActivityText !== snapshot.agentActivityText
      || prev.agentActivityLive !== snapshot.agentActivityLive
      || prev.agentActivitySource !== snapshot.agentActivitySource
      || prev.pendingApprovals.length !== snapshot.pendingApprovals.length
      || queueSig !== prevQueueSig
      || prev.mode?.current !== snapshot.mode?.current
      || prev.model?.current !== snapshot.model?.current
      || prev.model?.currentId !== snapshot.model?.currentId
      || messageFingerprint(prev.messages) !== messageFingerprint(snapshot.messages)
      || elementsSignature(prev.messages) !== elementsSignature(snapshot.messages);

    this.snapshots.set(windowId, snapshot);

    if (changed) {
      this.emit('window:update', windowId, snapshot);
    }
  }

  /**
   * Poll non-home windows by opening temporary parallel CDP connections.
   * Does NOT switch the main CDPBridge — the UI stays on the home window.
   */
  private async cycle(): Promise<void> {
    if (this._cycling) return;
    if (!this.cdpBridge.isConnected()) return;

    try {
      await this.cdpBridge.refreshWindows();
    } catch {
      return;
    }

    const windows = this.cdpBridge.windows;

    // Log full window inventory on first cycle
    if (!this._firstCycleLogged) {
      this._firstCycleLogged = true;
      const homeId = this.getHomeWindowId();
      console.log(`[window-monitor] First cycle — ${windows.length} window(s), home=${homeId?.substring(0, 8) ?? 'none'}:`);
      for (const w of windows) {
        const isHome = w.id === homeId;
        console.log(`  [${w.id.substring(0, 8)}] "${w.title}" ws=${w.wsUrl ? 'yes' : 'NO'}${isHome ? ' (home)' : ''}`);
      }
    }

    if (windows.length <= 1) return;

    const homeId = this.getHomeWindowId();
    const otherWindows = windows.filter(w => w.id !== homeId && w.wsUrl);
    if (otherWindows.length === 0) {
      const noWs = windows.filter(w => w.id !== homeId && !w.wsUrl);
      if (noWs.length > 0) {
        console.warn(`[window-monitor] ${noWs.length} non-home window(s) have no wsUrl (already debugged?): ${noWs.map(w => w.title).join(', ')}`);
      }
      return;
    }

    this._cycling = true;

    try {
      this.stateManager.updateWindows(windows, this.cdpBridge.activeTargetId);

      for (const win of otherWindows) {
        await this.pollWindowParallel(win);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[window-monitor] Cycle error: ${msg}`);
    } finally {
      this._cycling = false;
    }
  }

  private async pollWindowParallel(win: CursorWindow): Promise<void> {
    if (!win.wsUrl) return;

    const client = new CdpClient();
    try {
      await client.connect(win.wsUrl);

      const workspaceName = await extractWorkspaceName(client, this.config.windowTitleQualifier);
      const windowTitle = workspaceName ?? win.title;
      if (workspaceName && workspaceName !== win.title) {
        win.title = workspaceName;
      }

      const state = await this.extractFromClient(client, windowTitle);
      if (!state) {
        console.warn(`[window-monitor] Poll "${windowTitle}": extraction returned null`);
      }
      if (state) {
        const snapshot: WindowSnapshot = {
          windowId: win.id,
          windowTitle,
          messages: state.messages,
          chatTabs: state.chatTabs,
          pendingApprovals: state.pendingApprovals,
          agentStatus: state.agentStatus,
          agentActivityText: state.agentActivityText,
          agentActivityLive: state.agentActivityLive,
          agentActivitySource: state.agentActivitySource,
          composerQueue: state.composerQueue,
          mode: state.mode,
          model: state.model,
          lastUpdated: Date.now(),
        };

        const prev = this.snapshots.get(win.id);
        const qSig = JSON.stringify(snapshot.composerQueue);
        const pqSig = prev ? JSON.stringify(prev.composerQueue) : '';
        const changed = !prev
          || prev.messages.length !== snapshot.messages.length
          || (prev.messages.length > 0 && prev.messages[prev.messages.length - 1]?.id !== snapshot.messages[snapshot.messages.length - 1]?.id)
          || prev.agentStatus !== snapshot.agentStatus
          || prev.agentActivityText !== snapshot.agentActivityText
          || prev.agentActivityLive !== snapshot.agentActivityLive
          || prev.agentActivitySource !== snapshot.agentActivitySource
          || prev.pendingApprovals.length !== snapshot.pendingApprovals.length
          || qSig !== pqSig
          || prev.mode?.current !== snapshot.mode?.current
          || prev.model?.current !== snapshot.model?.current
          || prev.model?.currentId !== snapshot.model?.currentId
          || messageFingerprint(prev.messages) !== messageFingerprint(snapshot.messages)
          || elementsSignature(prev.messages) !== elementsSignature(snapshot.messages);

        this.snapshots.set(win.id, snapshot);

        if (changed) {
          this.emit('window:update', win.id, snapshot);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('WebSocket') && !msg.includes('closed')) {
        console.warn(`[window-monitor] Poll "${win.title}" failed: ${msg}`);
      }
    } finally {
      client.disconnect();
    }
  }

  private async extractFromClient(client: CdpClient, windowTitle: string): Promise<CursorState | null> {
    try {
      const { extractionFunction } = await import('./dom-extractor.js');

      const result = await client.callFunctionWithTimeout(
        extractionFunction as (...args: never[]) => unknown,
        [
          this.selectors.chatContainer?.strategies ?? [],
          this.selectors.approveButton?.strategies ?? [],
          this.selectors.approveButton?.textMatch ?? [],
          this.selectors.rejectButton?.strategies ?? [],
          this.selectors.rejectButton?.textMatch ?? [],
          this.selectors.chatInput?.strategies ?? [],
          this.selectors.agentStatus?.strategies ?? [],
          this.selectors.chatTabList?.strategies ?? [],
          this.selectors.modeDropdown?.strategies ?? [],
          this.selectors.modelDropdown?.strategies ?? [],
          windowTitle,
        ],
        5000
      );

      const state = result as CursorState | null;
      return state ? applyDerivedActivityToState(state) : null;
    } catch {
      return null;
    }
  }
}
