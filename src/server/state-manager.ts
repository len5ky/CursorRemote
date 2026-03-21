import { EventEmitter } from 'events';
import type { CursorState, CursorWindow } from './types.js';

function emptyState(): CursorState {
  return {
    connected: false,
    agentStatus: 'idle',
    messages: [],
    pendingApprovals: [],
    inputAvailable: false,
    chatTabs: [],
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: '' },
    windows: [],
    activeWindowId: '',
  };
}

export class StateManager extends EventEmitter {
  private currentState: CursorState = emptyState();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPatch: Partial<CursorState> | null = null;
  private debounceMs: number;
  private consecutiveNulls = 0;
  private readonly nullWarningThreshold = 10;
  private _generation = 0;

  get generation(): number {
    return this._generation;
  }

  constructor(debounceMs: number) {
    super();
    this.debounceMs = debounceMs;
  }

  getCurrentState(): CursorState {
    return this.currentState;
  }

  /**
   * Called by the DOM extractor on each poll cycle.
   * Diffs against previous state and emits patches.
   */
  onExtraction(newState: CursorState | null): void {
    if (newState === null) {
      this.consecutiveNulls++;
      if (this.consecutiveNulls === this.nullWarningThreshold) {
        console.warn(
          `[state-manager] ${this.nullWarningThreshold} consecutive null extractions. ` +
          'Selectors may need updating — run: npm run discover'
        );
      }
      return;
    }

    this.consecutiveNulls = 0;
    this._generation++;
    // Preserve bridge-managed fields that the DOM extractor doesn't populate
    newState.windows = this.currentState.windows;
    newState.activeWindowId = this.currentState.activeWindowId;

    const patch = this.diff(this.currentState, newState);
    if (!patch) return;

    this.currentState = newState;
    this.schedulePatch(patch);
  }

  onConnectionChanged(connected: boolean): void {
    if (this.currentState.connected === connected) return;
    this.currentState = { ...this.currentState, connected };
    this.emit('state:patch', { connected });
    this.emit('connection:changed', connected);
  }

  updateWindows(windows: CursorWindow[], activeWindowId: string): void {
    const changed =
      this.currentState.activeWindowId !== activeWindowId ||
      JSON.stringify(this.currentState.windows) !== JSON.stringify(windows);
    if (!changed) return;
    this.currentState = { ...this.currentState, windows, activeWindowId };
    this.emit('state:patch', { windows, activeWindowId });
  }

  private diff(
    prev: CursorState,
    next: CursorState
  ): Partial<CursorState> | null {
    const patch: Partial<CursorState> = {};
    let hasChange = false;

    if (prev.connected !== next.connected) {
      patch.connected = next.connected;
      hasChange = true;
    }

    if (prev.agentStatus !== next.agentStatus) {
      patch.agentStatus = next.agentStatus;
      hasChange = true;
    }

    if (prev.inputAvailable !== next.inputAvailable) {
      patch.inputAvailable = next.inputAvailable;
      hasChange = true;
    }

    if (JSON.stringify(prev.messages) !== JSON.stringify(next.messages)) {
      patch.messages = next.messages;
      hasChange = true;
    }

    if (JSON.stringify(prev.pendingApprovals) !== JSON.stringify(next.pendingApprovals)) {
      patch.pendingApprovals = next.pendingApprovals;
      hasChange = true;
    }

    if (JSON.stringify(prev.chatTabs) !== JSON.stringify(next.chatTabs)) {
      patch.chatTabs = next.chatTabs;
      hasChange = true;
    }

    if (prev.mode?.current !== next.mode?.current) {
      patch.mode = next.mode;
      hasChange = true;
    }

    if (prev.model?.current !== next.model?.current || prev.model?.currentId !== next.model?.currentId) {
      patch.model = next.model;
      hasChange = true;
    }

    if (JSON.stringify(prev.windows) !== JSON.stringify(next.windows)) {
      patch.windows = next.windows;
      hasChange = true;
    }

    if (prev.activeWindowId !== next.activeWindowId) {
      patch.activeWindowId = next.activeWindowId;
      hasChange = true;
    }

    return hasChange ? patch : null;
  }

  private schedulePatch(patch: Partial<CursorState>): void {
    this.pendingPatch = this.pendingPatch
      ? { ...this.pendingPatch, ...patch }
      : patch;

    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        if (this.pendingPatch) {
          this.emit('state:patch', this.pendingPatch);
          this.pendingPatch = null;
        }
      }, this.debounceMs);
    }
  }
}
