import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { CursorWindow, ChatTab } from '../../types.js';
import { cleanTabTitle } from '../../dom-extractor.js';
import type { TelegramApiClient } from './tg-types.js';

export interface TopicMapping {
  threadId: number;
  windowId: string;
  windowTitle: string;
  tabTitle: string;
  lastActive: number;
  /** data-composer-id of the agent this topic belongs to. Lets us tell apart
   *  two agents that happen to share a tab title across projects, and lets
   *  the cross-window fallback know when it's looking at the *same* agent
   *  shown via Cursor's global rail vs a coincidentally-named different one.
   *  Optional — older mappings persisted before this field was added won't
   *  have it, and per-(windowId, tabTitle) lookups still work for those. */
  composerId?: string;
}

const dataDir = process.env.DATA_DIR ?? './data';
const PERSIST_PATH = `${dataDir}/telegram-topics.json`;

/**
 * Canonical key for a window+tab. Uses windowId when available (stable within session).
 * windowTitle is fallback for persistence (windowId changes on Cursor restart).
 */
function makeRuntimeKey(windowId: string, tabTitle: string): string {
  return `${windowId}::${cleanTabTitle(tabTitle).toLowerCase()}`;
}

/**
 * Strip Cursor's connection-context suffixes from window titles so the same
 * project resolves to the same topic across sessions / connection modes.
 * Cursor adds these when a project is opened over WSL/SSH/Codespaces:
 *   "myproj"
 *   "myproj [WSL: ubuntu-24.04]"
 *   "myproj [SSH: my-host]"
 *   "myproj [Dev Container: foo]"
 *   "myproj [Codespaces]"
 * Without normalization the relay creates a fresh Telegram topic the first
 * time the user reopens a project in WSL — leaving the old non-WSL topic
 * orphaned and the new WSL topic empty of history.
 */
export function normalizeWindowTitle(title: string): string {
  return title
    .replace(/\s+\[(WSL|SSH|Dev Container|Codespaces|Container|Tunnel)[^\]]*\]\s*$/i, '')
    .trim();
}

function makeTitleKey(windowTitle: string, tabTitle: string): string {
  return `${normalizeWindowTitle(windowTitle).toLowerCase()}::${cleanTabTitle(tabTitle).toLowerCase()}`;
}

export class TopicManager {
  /** Primary: (windowId, tabTitle) -> mapping. Used for routing when we have windowId. */
  private byWindowIdTab = new Map<string, TopicMapping>();
  /** Fallback: (windowTitle, tabTitle) -> mapping[]. Multiple windows can share same title. */
  private byTitleTab = new Map<string, TopicMapping[]>();
  private byThread = new Map<number, TopicMapping>();
  private _highWaterMark = 0;

  get highWaterMark(): number {
    return this._highWaterMark;
  }

  constructor() {
    this.loadFromDisk();
  }

  resolveThread(threadId: number): TopicMapping | undefined {
    return this.byThread.get(threadId);
  }

  /**
   * Get thread for a snapshot. Uses windowId as primary key to disambiguate
   * when multiple windows share the same title (e.g. same project opened twice).
   */
  getThreadForSnapshot(
    windowId: string,
    windowTitle: string,
    tabTitle: string
  ): number | undefined {
    const cleaned = cleanTabTitle(tabTitle);
    const tabLower = cleaned.toLowerCase();
    const winLower = normalizeWindowTitle(windowTitle).toLowerCase();

    // 1. Primary: exact match by (windowId, tabTitle)
    const runtimeKey = makeRuntimeKey(windowId, cleaned);
    const byRuntime = this.byWindowIdTab.get(runtimeKey);
    if (byRuntime) {
      byRuntime.lastActive = Date.now();
      return byRuntime.threadId;
    }

    // 2. Find mapping that matches our windowId (update stale windowIds)
    for (const [, m] of this.byThread) {
      if (m.windowId === windowId && m.tabTitle.toLowerCase() === tabLower) {
        this.byWindowIdTab.set(runtimeKey, m);
        m.lastActive = Date.now();
        return m.threadId;
      }
    }

    // 3. Fallback: match by (windowTitle, tabTitle)
    const titleKey = makeTitleKey(windowTitle, cleaned);
    const candidates = this.byTitleTab.get(titleKey);
    if (!candidates || candidates.length === 0) return undefined;

    const byWindowId = candidates.find(m => m.windowId === windowId);
    if (byWindowId) {
      this.byWindowIdTab.set(runtimeKey, byWindowId);
      byWindowId.lastActive = Date.now();
      return byWindowId.threadId;
    }

    // Filter to candidates whose normalized title actually matches — prevents
    // cross-window hijacking when DOM extraction returns tabs from a sibling
    // project that happens to share a tab title.
    const titleMatches = candidates.filter(
      (m) => normalizeWindowTitle(m.windowTitle).toLowerCase() === winLower
    );
    if (titleMatches.length === 0) return undefined;

    // Multiple persisted mappings share the same (normalized title, tab) but
    // come from prior Cursor sessions with different windowIds. Reuse the most
    // recently active one — this is what the user last interacted with — and
    // re-bind it to the current windowId so future lookups go straight through.
    const best = titleMatches.reduce((a, b) => (a.lastActive >= b.lastActive ? a : b));
    best.windowId = windowId;
    this.byWindowIdTab.set(runtimeKey, best);
    best.lastActive = Date.now();
    return best.threadId;
  }

  /** @deprecated Use getThreadForSnapshot. Kept for sync_all and other callers. */
  getThreadForKey(windowTitle: string, tabTitle: string): number | undefined {
    const titleKey = makeTitleKey(windowTitle, cleanTabTitle(tabTitle));
    const candidates = this.byTitleTab.get(titleKey);
    if (!candidates || candidates.length === 0) return undefined;
    return candidates[0].threadId;
  }

  getActiveThread(
    windows: CursorWindow[],
    activeWindowId: string,
    chatTabs: ChatTab[]
  ): number | undefined {
    const win = windows.find(w => w.id === activeWindowId);
    if (!win) return undefined;
    const activeTab = chatTabs.find(t => t.isActive);
    if (!activeTab) return undefined;
    return this.getThreadForSnapshot(win.id, win.title, activeTab.title);
  }

  async createTopics(
    api: TelegramApiClient,
    chatId: number,
    windows: CursorWindow[],
    chatTabs: ChatTab[],
    activeWindowId: string
  ): Promise<TopicMapping[]> {
    const created: TopicMapping[] = [];

    for (const win of windows) {
      const tabs = win.id === activeWindowId ? chatTabs : [];
      const tabList = tabs.length > 0 ? tabs : [{ title: 'Default', composerId: '', isActive: true, status: '', selectorPath: '' }];

      for (const tab of tabList) {
        const cleaned = cleanTabTitle(tab.title);
        const runtimeKey = makeRuntimeKey(win.id, cleaned);
        if (this.byWindowIdTab.has(runtimeKey)) {
          created.push(this.byWindowIdTab.get(runtimeKey)!);
          continue;
        }
        const titleKey = makeTitleKey(win.title, cleaned);
        const existing = this.byTitleTab.get(titleKey)?.find(m => m.windowId === win.id);
        if (existing) {
          this.byWindowIdTab.set(runtimeKey, existing);
          created.push(existing);
          continue;
        }

        const topicName = `${win.title} — ${cleaned}`.substring(0, 128);
        try {
          const result = await api.createForumTopic(chatId, topicName);
          const mapping: TopicMapping = {
            threadId: result.message_thread_id,
            windowId: win.id,
            windowTitle: win.title,
            tabTitle: cleaned,
            lastActive: Date.now(),
          };
          this.addMapping(mapping);
          created.push(mapping);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[topic-manager] Failed to create topic "${topicName}": ${msg}`);
        }
      }
    }

    this.saveToDisk();
    return created;
  }

  private addMapping(mapping: TopicMapping): void {
    const runtimeKey = makeRuntimeKey(mapping.windowId, mapping.tabTitle);
    const titleKey = makeTitleKey(mapping.windowTitle, mapping.tabTitle);

    this.byWindowIdTab.set(runtimeKey, mapping);
    const list = this.byTitleTab.get(titleKey) ?? [];
    if (!list.find(m => m.threadId === mapping.threadId)) {
      list.push(mapping);
      this.byTitleTab.set(titleKey, list);
    }
    this.byThread.set(mapping.threadId, mapping);
    if (mapping.threadId > this._highWaterMark) {
      this._highWaterMark = mapping.threadId;
    }
  }

  registerMapping(mapping: TopicMapping): void {
    mapping.tabTitle = cleanTabTitle(mapping.tabTitle);
    this.addMapping(mapping);
    this.saveToDisk();
  }

  /** Save current state without modifying mappings. Used after callers mutate
   *  fields on a returned mapping reference (e.g. backfilling composerId on
   *  legacy entries). */
  persistInPlace(): void {
    this.saveToDisk();
  }

  getAllMappings(): TopicMapping[] {
    return Array.from(this.byThread.values());
  }

  /** Find an existing mapping whose composerId matches. Used to prevent
   *  duplicate topics when the same agent (stable Cursor data-composer-id)
   *  appears via different window+tab paths — e.g. once via the project's
   *  own workbench window, then again via the global 'Cursor Agents' window
   *  with a composite '<group> / <agent>' title that wouldn't otherwise
   *  collide on the (windowId, tabTitle) key. Returns the most-recently
   *  active mapping if there are several. */
  findByComposerId(composerId: string): TopicMapping | undefined {
    if (!composerId) return undefined;
    let best: TopicMapping | undefined;
    for (const m of this.byThread.values()) {
      if (m.composerId !== composerId) continue;
      if (!best || (m.lastActive ?? 0) > (best.lastActive ?? 0)) best = m;
    }
    return best;
  }

  /** Update a mapping's window/tab in place. Used by /remap when the user wants
   *  an existing topic re-bound to a different (windowId, windowTitle, tabTitle).
   *  Returns the updated mapping or undefined if threadId isn't tracked. */
  updateMappingTarget(threadId: number, windowId: string, windowTitle: string, tabTitle: string): TopicMapping | undefined {
    const existing = this.byThread.get(threadId);
    if (!existing) return undefined;
    // Drop old indexes that referenced the previous target.
    const oldRuntimeKey = makeRuntimeKey(existing.windowId, existing.tabTitle);
    if (this.byWindowIdTab.get(oldRuntimeKey)?.threadId === threadId) {
      this.byWindowIdTab.delete(oldRuntimeKey);
    }
    const oldTitleKey = makeTitleKey(existing.windowTitle, existing.tabTitle);
    const oldList = this.byTitleTab.get(oldTitleKey);
    if (oldList) {
      const filtered = oldList.filter((m) => m.threadId !== threadId);
      if (filtered.length === 0) this.byTitleTab.delete(oldTitleKey);
      else this.byTitleTab.set(oldTitleKey, filtered);
    }
    // Mutate in place so `byThread` and any external references stay consistent.
    existing.windowId = windowId;
    existing.windowTitle = windowTitle;
    existing.tabTitle = cleanTabTitle(tabTitle);
    existing.lastActive = Date.now();
    // Re-insert into runtime/title indexes under the new keys.
    const newRuntimeKey = makeRuntimeKey(existing.windowId, existing.tabTitle);
    this.byWindowIdTab.set(newRuntimeKey, existing);
    const newTitleKey = makeTitleKey(existing.windowTitle, existing.tabTitle);
    const list = this.byTitleTab.get(newTitleKey) ?? [];
    if (!list.find((m) => m.threadId === threadId)) {
      list.push(existing);
      this.byTitleTab.set(newTitleKey, list);
    }
    this.saveToDisk();
    return existing;
  }

  removeMapping(threadId: number): boolean {
    const mapping = this.byThread.get(threadId);
    if (!mapping) return false;
    this.byThread.delete(threadId);
    const runtimeKey = makeRuntimeKey(mapping.windowId, mapping.tabTitle);
    if (this.byWindowIdTab.get(runtimeKey)?.threadId === threadId) {
      this.byWindowIdTab.delete(runtimeKey);
    }
    const titleKey = makeTitleKey(mapping.windowTitle, mapping.tabTitle);
    const list = this.byTitleTab.get(titleKey);
    if (list) {
      const filtered = list.filter((m) => m.threadId !== threadId);
      if (filtered.length === 0) this.byTitleTab.delete(titleKey);
      else this.byTitleTab.set(titleKey, filtered);
    }
    this.saveToDisk();
    return true;
  }

  clearAll(): void {
    this.byWindowIdTab.clear();
    this.byTitleTab.clear();
    this.byThread.clear();
    this.saveToDisk();
  }

  resetHighWaterMark(): void {
    this._highWaterMark = 0;
    this.saveToDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(PERSIST_PATH)) return;
      const raw = readFileSync(PERSIST_PATH, 'utf-8');
      const data = JSON.parse(raw) as { mappings?: TopicMapping[]; highWaterMark?: number } | TopicMapping[];

      const mappings = Array.isArray(data) ? data : (data.mappings ?? []);
      const hwm = Array.isArray(data) ? 0 : (data.highWaterMark ?? 0);

      for (const m of mappings) {
        m.tabTitle = cleanTabTitle(m.tabTitle);
        if (m.threadId > this._highWaterMark) this._highWaterMark = m.threadId;
        this.addMapping(m);
      }
      if (hwm > this._highWaterMark) this._highWaterMark = hwm;

      console.log(`[topic-manager] Loaded ${this.byThread.size} mappings`);
    } catch {
      // Fresh start
    }
  }

  private saveToDisk(): void {
    try {
      const mappings = this.getAllMappings();
      writeFileSync(PERSIST_PATH, JSON.stringify({
        mappings,
        highWaterMark: this._highWaterMark,
      }, null, 2));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[topic-manager] Failed to save: ${msg}`);
    }
  }
}
