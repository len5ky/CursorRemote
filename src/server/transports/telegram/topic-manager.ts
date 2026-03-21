import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { Bot, Api, RawApi } from 'grammy';
import type { CursorWindow, ChatTab } from '../../types.js';
import { cleanTabTitle } from '../../dom-extractor.js';

export interface TopicMapping {
  threadId: number;
  windowId: string;
  windowTitle: string;
  tabTitle: string;
  lastActive: number;
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

function makeTitleKey(windowTitle: string, tabTitle: string): string {
  return `${windowTitle.toLowerCase()}::${cleanTabTitle(tabTitle).toLowerCase()}`;
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
    const winLower = windowTitle.toLowerCase();

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

    if (candidates.length === 1) {
      const m = candidates[0];
      // Only reassign windowId if the windowTitle matches — prevents cross-window hijacking
      // when DOM extraction returns tabs from the wrong project
      if (m.windowTitle.toLowerCase() === winLower) {
        m.windowId = windowId;
        this.byWindowIdTab.set(runtimeKey, m);
        m.lastActive = Date.now();
        return m.threadId;
      }
      return undefined;
    }

    return undefined;
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
    bot: Bot | { api: Api<RawApi> },
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
          const result = await bot.api.createForumTopic(chatId, topicName);
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

  getAllMappings(): TopicMapping[] {
    return Array.from(this.byThread.values());
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
