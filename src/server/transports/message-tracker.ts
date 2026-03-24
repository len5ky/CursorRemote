import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

export interface TrackedMessage {
  telegramMsgIds: number[];
  threadId: number;
  elementId: string;
  lastContentHash: string;
  type: string;
}

interface PersistedData {
  messages: Record<string, TrackedMessage>;
  selectorHashes: Record<string, string>;
}

const SAVE_DEBOUNCE_MS = 5000;

export class MessageTracker {
  private messages = new Map<string, TrackedMessage>();
  private selectorHashes = new Map<string, string>();
  private persistPath: string | null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(persistPath?: string) {
    this.persistPath = persistPath ?? null;
    if (this.persistPath) this.loadFromDisk();
  }

  private makeKey(threadId: number, elementId: string): string {
    return `${threadId}:${elementId}`;
  }

  getTracked(threadId: number, elementId: string): TrackedMessage | undefined {
    return this.messages.get(this.makeKey(threadId, elementId));
  }

  track(
    threadId: number,
    elementId: string,
    msgIds: number[],
    contentHash: string,
    type: string
  ): void {
    this.messages.set(this.makeKey(threadId, elementId), {
      telegramMsgIds: msgIds,
      threadId,
      elementId,
      lastContentHash: contentHash,
      type,
    });
    this.scheduleSave();
  }

  hasChanged(threadId: number, elementId: string, newContentHash: string): boolean {
    const existing = this.getTracked(threadId, elementId);
    if (!existing) return true;
    return existing.lastContentHash !== newContentHash;
  }

  isTracked(threadId: number, elementId: string): boolean {
    return this.messages.has(this.makeKey(threadId, elementId));
  }

  untrack(threadId: number, elementId: string): void {
    this.messages.delete(this.makeKey(threadId, elementId));
    this.scheduleSave();
  }

  clearThread(threadId: number): void {
    for (const [key, msg] of this.messages) {
      if (msg.threadId === threadId) {
        this.messages.delete(key);
      }
    }
    this.scheduleSave();
  }

  clearAll(): void {
    this.messages.clear();
    this.selectorHashes.clear();
    this.dirty = true;
    this.flush();
  }

  static contentHash(content: string): string {
    return createHash('md5').update(content).digest('hex').substring(0, 12);
  }

  hashSelector(selectorPath: string): string {
    const hash = createHash('md5').update(selectorPath).digest('hex').substring(0, 8);
    this.selectorHashes.set(hash, selectorPath);
    this.scheduleSave();
    return hash;
  }

  resolveHash(hash: string): string | undefined {
    return this.selectorHashes.get(hash);
  }

  private scheduleSave(): void {
    if (!this.persistPath) return;
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        if (this.dirty) {
          this.saveToDisk();
          this.dirty = false;
        }
      }, SAVE_DEBOUNCE_MS);
    }
  }

  flush(): void {
    if (this.dirty && this.persistPath) {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      this.saveToDisk();
      this.dirty = false;
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedData;
      for (const [key, msg] of Object.entries(data.messages)) {
        this.messages.set(key, msg);
      }
      for (const [hash, path] of Object.entries(data.selectorHashes)) {
        this.selectorHashes.set(hash, path);
      }
      console.log(`[message-tracker] Loaded ${this.messages.size} tracked messages from ${this.persistPath}`);
    } catch {
      console.log(`[message-tracker] No existing data at ${this.persistPath}, starting fresh`);
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      const data: PersistedData = {
        messages: Object.fromEntries(this.messages),
        selectorHashes: Object.fromEntries(this.selectorHashes),
      };
      writeFileSync(this.persistPath, JSON.stringify(data));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[message-tracker] Failed to save: ${msg}`);
    }
  }
}
