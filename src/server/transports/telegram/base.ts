import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import type { Transport } from '../types.js';
import type { TelegramConfig, CursorState, ChatElement } from '../../types.js';
import type { StateManager } from '../../state-manager.js';
import type { CommandExecutor } from '../../command-executor.js';
import type { CDPBridge } from '../../cdp-bridge.js';
import type { WindowMonitor, WindowSnapshot } from '../../window-monitor.js';
import { cleanTabTitle } from '../../dom-extractor.js';
import { TopicManager } from './topic-manager.js';
import { MessageTracker } from '../message-tracker.js';
import { SendQueue } from '../send-queue.js';
import {
  formatElement,
  formatActivity,
  formatApprovals,
  formatQuestionnaire,
  formatComposerQueue,
  splitMessage,
  activityRedundantWithInProgressStepSummary,
  type FormattedMessage,
} from './formatter.js';
import { AGENT_ACTIVITY_STALE_MS } from '../../activity-stale.js';
import type { TelegramApiClient, BotContext } from './tg-types.js';
import type { CommandDeps, RegisterDeps } from './commands.js';
import {
  handleSync,
  handleSyncAll,
  handleUnsync,
  handlePurge,
  handleCleanup,
  handleStatus,
  handleHistory,
  handleMode,
  handleModel,
  handlePlanCommand,
  handleAgentCommand,
  handleCallbackQuery,
  handleTextMessage,
  handleRegister,
} from './commands.js';

const TYPING_INTERVAL_MS = 4000;
const MAX_INITIAL_MESSAGES = 5;
const TOPIC_CREATE_DELAY_MS = 1500;
const dataDir = process.env.DATA_DIR ?? './data';
const SYNC_STATE_PATH = `${dataDir}/telegram-sync.json`;
const AUTH_PATH = `${dataDir}/telegram-auth.json`;
const ACTIVITY_PATH = `${dataDir}/telegram-activity.json`;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface RegisteredUser {
  id: number;
  username?: string;
  firstName?: string;
  registeredAt: string;
}

interface AuthState {
  token: string;
  registeredUsers: RegisteredUser[];
}

export const BOT_COMMANDS = [
  { command: 'register', description: 'Register with token: /register <token>' },
  { command: 'sync', description: 'Enable auto-sync (active tabs)' },
  { command: 'sync_all', description: 'Create topics for ALL tabs in all windows' },
  { command: 'unsync', description: 'Disable sync and delete tracked topics' },
  { command: 'cleanup', description: 'Delete untracked/stale topics' },
  { command: 'purge', description: 'Delete ALL forum topics (nuclear reset)' },
  { command: 'status', description: 'Connection status, sync state' },
  { command: 'history', description: 'Chat history: /history [count]' },
  { command: 'mode', description: 'Show/switch agent mode' },
  { command: 'model', description: 'Show/switch model (inline buttons)' },
  { command: 'plan', description: 'Send prompt in Plan mode' },
  { command: 'agent', description: 'Send prompt in Agent mode' },
] as const;

export abstract class BaseTelegramTransport implements Transport {
  readonly name = 'telegram';

  protected api!: TelegramApiClient;
  protected config: TelegramConfig;
  protected stateManager: StateManager;
  protected commandExecutor: CommandExecutor;
  protected cdpBridge: CDPBridge;
  protected windowMonitor: WindowMonitor;
  protected topicManager: TopicManager;
  protected messageTracker: MessageTracker;
  protected sendQueue: SendQueue;

  private typingInterval: ReturnType<typeof setInterval> | null = null;
  private activityStaleTimer: ReturnType<typeof setInterval> | null = null;
  protected started = false;
  protected groupId: number | undefined;
  private seenThreads = new Set<number>();
  private processing = new Set<string>();
  private pendingSnapshots = new Map<string, WindowSnapshot>();
  protected syncEnabled = false;
  private creatingTopic = new Set<string>();
  private activityMsgIds = new Map<number, number>();
  private lastActivityText = new Map<number, string>();
  private activityTimestamps = new Map<number, number>();
  private queueMsgIds = new Map<number, number>();
  private lastQueueSig = new Map<number, string>();
  protected authState: AuthState;
  protected registeredUsers: Set<number>;

  protected get chatId(): number | undefined {
    return this.groupId;
  }

  get registerToken(): string {
    return this.authState.token;
  }

  get registeredUserNames(): string[] {
    return this.authState.registeredUsers.map(
      u => u.username ? `@${u.username}` : u.firstName ?? String(u.id)
    );
  }

  constructor(
    config: TelegramConfig,
    windowMonitor: WindowMonitor,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    this.config = config;
    this.windowMonitor = windowMonitor;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.topicManager = new TopicManager();
    this.messageTracker = new MessageTracker(`${dataDir}/telegram-messages.json`);
    this.sendQueue = new SendQueue({ sendDelayMs: 300, editDelayMs: 100, maxRetries: 3, maxQueueSize: 500 });

    this.authState = this.loadAuth();
    if (config.preRegisteredUsers.length > 0) {
      this.registeredUsers = new Set(config.preRegisteredUsers);
      console.log(`[telegram] Using TELEGRAM_ALLOWED_USERS: ${config.preRegisteredUsers.join(', ')}`);
    } else {
      this.registeredUsers = new Set(this.authState.registeredUsers.map(u => u.id));
    }
    this.loadSyncState();
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  // --- Shared startup: verify API reachability, clear webhooks, detect conflicts ---

  protected async connectAndVerify(): Promise<string | null> {
    const maskedToken = this.config.botToken.slice(0, 6) + '...' + this.config.botToken.slice(-4);
    console.log(`[telegram] Starting bot (token: ${maskedToken})...`);

    const apiBase = `https://api.telegram.org/bot${this.config.botToken}`;
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 2000;

    let botUsername: string | undefined;
    let connected = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(`${apiBase}/getMe`, { signal: AbortSignal.timeout(10000) });
        const data = await resp.json() as { ok: boolean; error_code?: number; description?: string; result?: { username?: string } };

        if (data.ok) {
          botUsername = data.result?.username;
          connected = true;
          break;
        }

        if (resp.status === 401 || data.error_code === 401) {
          console.error('[telegram] Invalid bot token (401 Unauthorized) — not retrying');
          return null;
        }

        console.warn(`[telegram] getMe returned ok=false (HTTP ${resp.status}: ${data.description ?? 'unknown'})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[telegram] Connection attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
      }

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[telegram] Retrying in ${(delay / 1000).toFixed(0)}s...`);
        await sleep(delay);
      }
    }

    if (!connected) {
      try {
        await fetch('https://www.google.com', { signal: AbortSignal.timeout(5000) });
        console.error('[telegram] google.com reachable — issue is Telegram-specific (DNS/blocked/token)');
      } catch {
        console.error('[telegram] No outbound HTTPS from this process. Check proxy/firewall for Node.js.');
      }
      console.error(`[telegram] Giving up after ${MAX_RETRIES} attempts`);
      return null;
    }

    console.log(`[telegram] API reachable — bot: @${botUsername}`);

    try {
      await fetch(`${apiBase}/deleteWebhook?drop_pending_updates=true`, { signal: AbortSignal.timeout(5000) });
      console.log('[telegram] Cleared any stale webhook/session (dropped pending updates)');
    } catch {
      // non-fatal
    }

    try {
      const probe = await fetch(`${apiBase}/getUpdates?limit=1&timeout=0`, { signal: AbortSignal.timeout(10000) });
      const probeData = await probe.json() as { ok: boolean; error_code?: number; description?: string };
      if (!probeData.ok && (probe.status === 409 || probeData.error_code === 409)) {
        console.error('[telegram] 409 Conflict — another bot instance is already polling with this token');
        console.error('[telegram] Stop the other instance first, or it will fight for updates');
        return null;
      }
      console.log(`[telegram] getUpdates probe ok=${probeData.ok}`);
    } catch (err) {
      console.warn(`[telegram] getUpdates probe failed: ${err instanceof Error ? err.message : err}`);
    }

    return botUsername ?? 'unknown';
  }

  protected attachListeners(): void {
    this.windowMonitor.on('window:update', this.onWindowUpdate);
    this.stateManager.on('state:patch', this.onStatePatch);
    this.stateManager.on('connection:changed', this.onConnectionChanged);
  }

  protected detachListeners(): void {
    this.windowMonitor.off('window:update', this.onWindowUpdate);
    this.stateManager.off('state:patch', this.onStatePatch);
    this.stateManager.off('connection:changed', this.onConnectionChanged);
  }

  protected setupStaleTimer(): void {
    this.activityStaleTimer = setInterval(() => this.cleanStaleActivity(), 15000);
  }

  protected onBotConnected(): void {
    console.log(`[telegram] Bot connected (sync: ${this.syncEnabled ? 'on' : 'off'})`);
    this.started = true;
    this.cleanupPersistedActivity();
  }

  protected onStop(): void {
    this.started = false;
    this.detachListeners();
    if (this.activityStaleTimer) { clearInterval(this.activityStaleTimer); this.activityStaleTimer = null; }
    this.deleteAllActivityMessages();
    this.stopTyping();
    this.messageTracker.flush();
  }

  // --- Command handler dispatch ---

  protected buildCommandDeps(): CommandDeps {
    const self = this;
    return {
      api: this.api,
      stateManager: this.stateManager,
      commandExecutor: this.commandExecutor,
      cdpBridge: this.cdpBridge,
      topicManager: this.topicManager,
      messageTracker: this.messageTracker,
      windowMonitor: this.windowMonitor,
      get chatId() { return self.groupId; },
      getSyncEnabled: () => this.syncEnabled,
      setSyncEnabled: (enabled: boolean, chatId?: number) => {
        this.syncEnabled = enabled;
        if (chatId !== undefined) this.groupId = chatId;
        if (!enabled) this.groupId = undefined;
        this.saveSyncState();
      },
      setChatId: (id: number) => {
        this.groupId = id;
        this.saveSyncState();
      },
      resetAllState: () => this.resetAllState(),
    };
  }

  protected buildRegisterDeps(): RegisterDeps {
    return {
      authState: this.authState,
      registeredUsers: this.registeredUsers,
      registerUser: (id, username, firstName) => this.registerUser(id, username, firstName),
    };
  }

  protected async dispatchCommand(cmd: string, ctx: BotContext, deps: CommandDeps): Promise<void> {
    switch (cmd) {
      case 'sync': return handleSync(ctx, deps);
      case 'sync_all': return handleSyncAll(ctx, deps);
      case 'unsync': return handleUnsync(ctx, deps);
      case 'cleanup': return handleCleanup(ctx, deps);
      case 'purge': return handlePurge(ctx, deps);
      case 'status': return handleStatus(ctx, deps);
      case 'history': return handleHistory(ctx, deps);
      case 'mode': return handleMode(ctx, deps);
      case 'model': return handleModel(ctx, deps);
      case 'plan': return handlePlanCommand(ctx, deps);
      case 'agent': return handleAgentCommand(ctx, deps);
    }
  }

  // --- Auth persistence ---

  private loadAuth(): AuthState {
    try {
      if (existsSync(AUTH_PATH)) {
        const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf-8'));
        if (raw.token && raw.registeredUsers) {
          const users: RegisteredUser[] = raw.registeredUsers.map((u: RegisteredUser | number) =>
            typeof u === 'number' ? { id: u, registeredAt: 'unknown' } : u
          );
          const state: AuthState = { token: raw.token, registeredUsers: users };
          const names = users.map(u => u.username ? `@${u.username}` : String(u.id)).join(', ');
          console.log(`[telegram] Auth loaded: ${users.length} user(s) [${names}]`);
          return state;
        }
      }
    } catch { /* fresh start */ }

    const token = randomBytes(16).toString('hex');
    const state: AuthState = { token, registeredUsers: [] };
    this.saveAuthState(state);
    return state;
  }

  registerUser(userId: number, username?: string, firstName?: string): void {
    this.registeredUsers.add(userId);
    const existing = this.authState.registeredUsers.find(u => u.id === userId);
    if (!existing) {
      this.authState.registeredUsers.push({
        id: userId,
        username,
        firstName,
        registeredAt: new Date().toISOString(),
      });
    } else {
      if (username) existing.username = username;
      if (firstName) existing.firstName = firstName;
    }
    this.saveAuthState(this.authState);
  }

  private saveAuthState(state: AuthState): void {
    try {
      writeFileSync(AUTH_PATH, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn('[telegram] Failed to save auth:', err instanceof Error ? err.message : err);
    }
  }

  resetAllState(): void {
    this.seenThreads.clear();
    this.creatingTopic.clear();
    this.processing.clear();
    this.pendingSnapshots.clear();
    this.topicManager.clearAll();
    this.messageTracker.clearAll();
    this.deleteAllActivityMessages();
    console.log('[telegram] All state reset');
  }

  private deleteActivityMessage(threadId: number): void {
    const msgId = this.activityMsgIds.get(threadId);
    if (!msgId) return;
    this.api.deleteMessage(this.chatId!, msgId).catch(() => {});
    console.log(`[telegram] Activity deleted (msgId=${msgId}, thread=${threadId})`);
    this.activityMsgIds.delete(threadId);
    this.lastActivityText.delete(threadId);
    this.activityTimestamps.delete(threadId);
    this.saveActivityState();
  }

  private deleteAllActivityMessages(): void {
    for (const threadId of [...this.activityMsgIds.keys()]) {
      this.deleteActivityMessage(threadId);
    }
  }

  private cleanStaleActivity(): void {
    const now = Date.now();
    for (const [threadId, ts] of this.activityTimestamps) {
      if (now - ts > AGENT_ACTIVITY_STALE_MS && this.activityMsgIds.has(threadId)) {
        console.log(`[telegram] Activity stale (${((now - ts) / 1000).toFixed(0)}s), cleaning up`);
        this.deleteActivityMessage(threadId);
      }
    }
  }

  private saveActivityState(): void {
    try {
      const data: Record<string, number> = {};
      for (const [threadId, msgId] of this.activityMsgIds) data[String(threadId)] = msgId;
      writeFileSync(ACTIVITY_PATH, JSON.stringify(data));
    } catch { /* best effort */ }
  }

  private cleanupPersistedActivity(): void {
    try {
      if (!existsSync(ACTIVITY_PATH)) return;
      const raw = JSON.parse(readFileSync(ACTIVITY_PATH, 'utf-8')) as Record<string, number>;
      const entries = Object.entries(raw);
      if (entries.length === 0) return;
      console.log(`[telegram] Cleaning ${entries.length} persisted activity message(s)`);
      for (const [, msgId] of entries) {
        if (this.chatId) {
          this.api.deleteMessage(this.chatId, msgId).catch(() => {});
        }
      }
      writeFileSync(ACTIVITY_PATH, '{}');
    } catch { /* ok on first run */ }
  }

  // --- Sync state persistence ---

  private loadSyncState(): void {
    try {
      if (!existsSync(SYNC_STATE_PATH)) return;
      const data = JSON.parse(readFileSync(SYNC_STATE_PATH, 'utf-8')) as { enabled: boolean; chatId?: number };
      this.syncEnabled = data.enabled;
      if (data.chatId) this.groupId = data.chatId;
      console.log(`[telegram] Sync state: ${this.syncEnabled ? 'enabled' : 'disabled'}${this.groupId ? ` (group ${this.groupId})` : ''}`);
    } catch { /* fresh start */ }
  }

  private saveSyncState(): void {
    try {
      writeFileSync(SYNC_STATE_PATH, JSON.stringify({
        enabled: this.syncEnabled,
        chatId: this.groupId ?? null,
      }));
    } catch (err) {
      console.warn('[telegram] Failed to save sync state:', err instanceof Error ? err.message : err);
    }
  }

  // --- Event handlers ---

  private onWindowUpdate = (windowId: string, snapshot: WindowSnapshot): void => {
    if (!this.started || !this.syncEnabled || !this.chatId) return;
    this.processWindow(windowId, snapshot);
  };

  private onStatePatch = (patch: Partial<CursorState>): void => {
    if (!this.started || !this.syncEnabled || !this.chatId) return;

    if (patch.pendingApprovals) {
      this.processApprovals(patch.pendingApprovals).catch(err => {
        console.error('[telegram] Approval error:', err);
      });
    }

    if ('questionnaire' in patch) {
      this.processQuestionnaire(patch.questionnaire ?? null).catch(err => {
        console.error('[telegram] Questionnaire error:', err);
      });
    }

    if ('agentStatus' in patch || 'agentActivityLive' in patch || 'agentActivityText' in patch) {
      this.syncTypingIndicator();
    }
  };

  private onConnectionChanged = (connected: boolean): void => {
    if (!this.started || !this.syncEnabled || !this.chatId) return;
    if (this.windowMonitor.isCycling) return;

    const text = connected
      ? '✅ Reconnected to Cursor IDE'
      : '⚠️ Disconnected from Cursor IDE';

    this.sendQueue.enqueue(
      () => this.api.sendMessage(this.chatId!, text),
      'send'
    ).catch(() => {});

    if (!connected) {
      this.deleteAllActivityMessages();
      this.stopTyping();
    }
  };

  // --- Message processing ---

  private async syncComposerQueueMessage(threadId: number, snapshot: WindowSnapshot): Promise<void> {
    if (!this.chatId) return;
    const queue = snapshot.composerQueue ?? { items: [] };
    const sig = JSON.stringify(queue.items) + '\n' + (queue.queueLabel ?? '');
    if (this.lastQueueSig.get(threadId) === sig) return;

    const html = formatComposerQueue(queue);
    const existingId = this.queueMsgIds.get(threadId);

    if (!html) {
      if (existingId) {
        try {
          await this.sendQueue.enqueue(
            () => this.api.deleteMessage(this.chatId!, existingId),
            'send'
          );
        } catch { /* ok */ }
        this.queueMsgIds.delete(threadId);
      }
      this.lastQueueSig.set(threadId, sig);
      return;
    }

    try {
      if (existingId) {
        await this.sendQueue.enqueue(
          () => this.api.editMessageText(this.chatId!, existingId, html, {
            parse_mode: 'HTML',
          }),
          'edit'
        );
      } else {
        const sent = await this.sendQueue.enqueue(
          () => this.api.sendMessage(this.chatId!, html, {
            message_thread_id: threadId,
            parse_mode: 'HTML',
          }),
          'send'
        );
        this.queueMsgIds.set(threadId, sent.message_id);
      }
      this.lastQueueSig.set(threadId, sig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('message to edit not found')) {
        this.queueMsgIds.delete(threadId);
      }
      if (!msg.includes('message is not modified')) {
        console.warn(`[telegram] Queue message failed: ${msg}`);
      }
    }
  }

  private processWindow(windowId: string, snapshot: WindowSnapshot): void {
    if (this.processing.has(windowId)) {
      this.pendingSnapshots.set(windowId, snapshot);
      return;
    }
    this.processing.add(windowId);

    const processNext = (): void => {
      const pending = this.pendingSnapshots.get(windowId);
      this.pendingSnapshots.delete(windowId);
      if (pending) {
        this.doProcessWindow(windowId, pending)
          .catch(err => console.error(`[telegram] Process error for ${pending.windowTitle}:`, err))
          .finally(processNext);
      } else {
        this.processing.delete(windowId);
      }
    };

    this.doProcessWindow(windowId, snapshot)
      .catch(err => console.error(`[telegram] Process error for ${snapshot.windowTitle}:`, err))
      .finally(processNext);
  }

  private async doProcessWindow(windowId: string, snapshot: WindowSnapshot): Promise<void> {
    if (!this.chatId) return;

    if (snapshot.chatTabs.length === 0) return;

    const activeTab = snapshot.chatTabs.find(t => t.isActive)
      ?? (snapshot.chatTabs.length === 1 ? snapshot.chatTabs[0] : undefined);
    if (!activeTab) return;

    const cleanedTab = cleanTabTitle(activeTab.title);

    const existingThread = this.topicManager.getThreadForSnapshot(windowId, snapshot.windowTitle, cleanedTab);
    if (!existingThread) {
      const existingByTitle = this.topicManager.getThreadForKey(snapshot.windowTitle, cleanedTab);
      if (!existingByTitle) {
        const mapping = this.findMappingByTabTitle(cleanedTab);
        if (mapping && mapping.windowId !== windowId && mapping.windowTitle.toLowerCase() !== snapshot.windowTitle.toLowerCase()) {
          console.warn(`[telegram] Skipping "${cleanedTab}" for window "${snapshot.windowTitle}" — already belongs to "${mapping.windowTitle}"`);
          return;
        }
      }
    }

    let threadId = existingThread;

    if (!threadId) {
      threadId = await this.autoCreateTopic(snapshot.windowTitle, cleanedTab, windowId);
      if (!threadId) return;
    }

    const mapping = this.topicManager.resolveThread(threadId);
    if (!mapping) return;

    const messages = snapshot.messages;

    const activityText = snapshot.agentActivityLive ? snapshot.agentActivityText : null;
    const existingActivityMsgId = this.activityMsgIds.get(threadId);
    const prevActivityText = this.lastActivityText.get(threadId);
    const now = Date.now();
    const activitySuppressed = activityRedundantWithInProgressStepSummary(activityText ?? undefined, messages);

    if (activitySuppressed && existingActivityMsgId) {
      this.deleteActivityMessage(threadId);
    }

    if (!activitySuppressed) {
      if (activityText && !this.activityMsgIds.get(threadId)) {
        const html = formatActivity(activityText);
        try {
          const sent = await this.sendQueue.enqueue(
            () => this.api.sendMessage(this.chatId!, html, {
              message_thread_id: threadId,
              parse_mode: 'HTML',
            }),
            'send'
          );
          this.activityMsgIds.set(threadId, sent.message_id);
          this.lastActivityText.set(threadId, activityText);
          this.activityTimestamps.set(threadId, now);
          this.saveActivityState();
          console.log(`[telegram] Activity sent: "${activityText}" (msgId=${sent.message_id})`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[telegram] Activity send failed: ${msg}`);
        }
      } else if (activityText && this.activityMsgIds.get(threadId) && activityText !== prevActivityText) {
        const msgId = this.activityMsgIds.get(threadId)!;
        const html = formatActivity(activityText);
        try {
          await this.sendQueue.enqueue(
            () => this.api.editMessageText(this.chatId!, msgId, html, {
              parse_mode: 'HTML',
            }),
            'edit'
          );
          this.lastActivityText.set(threadId, activityText);
          this.activityTimestamps.set(threadId, now);
        } catch { /* message might not have changed */ }
      }
    }

    if (!activityText && this.activityMsgIds.has(threadId)) {
      this.deleteActivityMessage(threadId);
    }

    await this.syncComposerQueueMessage(threadId, snapshot);

    if (messages.length === 0) return;

    if (!this.seenThreads.has(threadId)) {
      this.seenThreads.add(threadId);
      const skipCount = Math.max(0, messages.length - MAX_INITIAL_MESSAGES);
      if (skipCount > 0) {
        for (let i = 0; i < skipCount; i++) {
          if (!this.messageTracker.isTracked(threadId, messages[i].id)) {
            this.messageTracker.track(threadId, messages[i].id, [], 'skipped', messages[i].type);
          }
        }
      }
    }

    const hashCallback = (sp: string) => this.messageTracker.hashSelector(sp);
    const tail = messages.slice(-Math.min(messages.length, MAX_INITIAL_MESSAGES + 10));

    for (const element of tail) {
      if (element.type === 'loading') continue;

      const formatted = formatElement(element, hashCallback);
      if (!formatted.html) continue;

      const keyboardSuffix = formatted.keyboard ? `\x00kb:${JSON.stringify(formatted.keyboard)}` : '';
      const contentHash = MessageTracker.contentHash(formatted.html + keyboardSuffix);
      const tracked = this.messageTracker.getTracked(threadId, element.id);

      if (tracked) {
        if (!this.messageTracker.hasChanged(threadId, element.id, contentHash)) continue;
        const mainMsgId = tracked.telegramMsgIds[0];
        if (!mainMsgId) continue;

        try {
          const parts = splitMessage(formatted.html);
          const allMsgIds = [...tracked.telegramMsgIds];

          try {
            await this.sendQueue.enqueue(
              () => this.api.editMessageText(this.chatId!, mainMsgId, parts[0], {
                parse_mode: 'HTML',
                reply_markup: parts.length === 1 ? formatted.keyboard : undefined,
              }),
              'edit'
            );
          } catch (htmlErr) {
            const htmlMsg = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
            if (htmlMsg.includes('parse entities') || htmlMsg.includes('start tag')) {
              await this.sendQueue.enqueue(
                () => this.api.editMessageText(this.chatId!, mainMsgId, parts[0].replace(/<[^>]*>/g, ''), {
                  reply_markup: parts.length === 1 ? formatted.keyboard : undefined,
                }),
                'edit'
              );
            } else {
              throw htmlErr;
            }
          }

          for (let i = 1; i < parts.length; i++) {
            if (allMsgIds[i]) {
              try {
                await this.sendQueue.enqueue(
                  () => this.api.editMessageText(this.chatId!, allMsgIds[i], parts[i], {
                    parse_mode: 'HTML',
                    reply_markup: i === parts.length - 1 ? formatted.keyboard : undefined,
                  }),
                  'edit'
                );
              } catch { /* ok */ }
            } else {
              try {
                const sent = await this.sendQueue.enqueue(
                  () => this.api.sendMessage(this.chatId!, parts[i], {
                    message_thread_id: threadId,
                    parse_mode: 'HTML',
                    reply_markup: i === parts.length - 1 ? formatted.keyboard : undefined,
                  }),
                  'send'
                );
                allMsgIds.push(sent.message_id);
              } catch { /* ok */ }
            }
          }

          this.messageTracker.track(threadId, element.id, allMsgIds, contentHash, element.type);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('message is not modified')) {
            this.messageTracker.track(threadId, element.id, tracked.telegramMsgIds, contentHash, element.type);
          } else if (msg.includes('not found')) {
            this.messageTracker.track(threadId, element.id, [], 'dead', element.type);
          }
        }
      } else {
        await this.sendNewMessage(threadId, element, formatted, contentHash);
      }
    }

    // Process questionnaire using this thread's threadId (guaranteed to exist here).
    // This ensures the questionnaire is sent even when a new topic was just created
    // for messages (plan widget) in this same cycle.
    const currentQuestionnaire = this.stateManager.getCurrentState().questionnaire;
    await this.processQuestionnaireForThread(threadId, currentQuestionnaire);
  }

  private async sendNewMessage(
    threadId: number,
    element: ChatElement,
    formatted: FormattedMessage,
    contentHash: string
  ): Promise<void> {
    try {
      const parts = splitMessage(formatted.html);
      const msgIds: number[] = [];

      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        let sent;
        try {
          sent = await this.sendQueue.enqueue(
            () => this.api.sendMessage(this.chatId!, parts[i], {
              message_thread_id: threadId,
              parse_mode: 'HTML',
              reply_markup: isLast ? formatted.keyboard : undefined,
            }),
            'send'
          );
        } catch (htmlErr) {
          const htmlMsg = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
          if (htmlMsg.includes('parse entities') || htmlMsg.includes('start tag')) {
            sent = await this.sendQueue.enqueue(
              () => this.api.sendMessage(this.chatId!, parts[i].replace(/<[^>]*>/g, ''), {
                message_thread_id: threadId,
                reply_markup: isLast ? formatted.keyboard : undefined,
              }),
              'send'
            );
          } else {
            throw htmlErr;
          }
        }
        msgIds.push(sent.message_id);
      }

      this.messageTracker.track(threadId, element.id, msgIds, contentHash, element.type);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('thread not found') || msg.includes('chat not found')) {
        this.messageTracker.track(threadId, element.id, [], 'dead-thread', element.type);
        return;
      }
      console.warn(`[telegram] Send failed: ${msg}`);
    }
  }

  private findMappingByTabTitle(tabTitle: string): import('./topic-manager.js').TopicMapping | undefined {
    const tabLower = cleanTabTitle(tabTitle).toLowerCase();
    for (const m of this.topicManager.getAllMappings()) {
      if (m.tabTitle.toLowerCase() === tabLower) return m;
    }
    return undefined;
  }

  private async autoCreateTopic(windowTitle: string, tabTitle: string, windowId: string): Promise<number | undefined> {
    if (!this.chatId) return undefined;

    const key = `${windowId}::${tabTitle}`;
    if (this.creatingTopic.has(key)) return undefined;
    this.creatingTopic.add(key);

    const topicName = `${windowTitle} — ${tabTitle}`.substring(0, 128);
    try {
      await sleep(TOPIC_CREATE_DELAY_MS);
      const result = await this.api.createForumTopic(this.chatId, topicName);
      this.topicManager.registerMapping({
        threadId: result.message_thread_id,
        windowId,
        windowTitle,
        tabTitle,
        lastActive: Date.now(),
      });
      return result.message_thread_id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not a forum') || msg.includes('not a supergroup')) {
        console.error(`[telegram] Group ${this.chatId} is not a forum. Disabling sync.`);
        this.syncEnabled = false;
        this.saveSyncState();
      } else {
        console.warn(`[telegram] Failed to auto-create "${topicName}": ${msg}`);
      }
      return undefined;
    } finally {
      this.creatingTopic.delete(key);
    }
  }

  private async processApprovals(approvals: CursorState['pendingApprovals']): Promise<void> {
    if (approvals.length === 0 || !this.chatId) return;

    const state = this.stateManager.getCurrentState();
    const threadId = this.topicManager.getActiveThread(
      state.windows, state.activeWindowId, state.chatTabs
    );
    if (!threadId) return;

    const hashCallback = (sp: string) => this.messageTracker.hashSelector(sp);
    const formatted = formatApprovals(approvals, hashCallback);
    if (!formatted.html) return;

    const approvalTrackId = 'approval';
    const contentHash = MessageTracker.contentHash(formatted.html + JSON.stringify(formatted.keyboard));
    const tracked = this.messageTracker.getTracked(threadId, approvalTrackId);

    if (tracked && !this.messageTracker.hasChanged(threadId, approvalTrackId, contentHash)) return;

    try {
      if (tracked && tracked.telegramMsgIds[0]) {
        await this.sendQueue.enqueue(
          () => this.api.editMessageText(this.chatId!, tracked.telegramMsgIds[0], formatted.html, {
            parse_mode: 'HTML',
            reply_markup: formatted.keyboard,
          }),
          'edit'
        );
        this.messageTracker.track(
          threadId, approvalTrackId, tracked.telegramMsgIds,
          contentHash, 'approval'
        );
      } else {
        const sent = await this.sendQueue.enqueue(
          () => this.api.sendMessage(this.chatId!, formatted.html, {
            message_thread_id: threadId,
            parse_mode: 'HTML',
            reply_markup: formatted.keyboard,
          }),
          'send'
        );
        this.messageTracker.track(
          threadId, approvalTrackId, [sent.message_id],
          contentHash, 'approval'
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('not found') && !msg.includes('not modified')) {
        console.warn('[telegram] Approval error:', msg);
      }
    }
  }

  private async processQuestionnaire(questionnaire: import('../../types.js').Questionnaire | null): Promise<void> {
    if (!this.chatId) return;

    const state = this.stateManager.getCurrentState();
    const threadId = this.topicManager.getActiveThread(
      state.windows, state.activeWindowId, state.chatTabs
    );
    if (!threadId) return;

    await this.processQuestionnaireForThread(threadId, questionnaire);
  }

  private async processQuestionnaireForThread(threadId: number, questionnaire: import('../../types.js').Questionnaire | null): Promise<void> {
    if (!this.chatId) return;

    const trackId = 'questionnaire';

    if (!questionnaire || questionnaire.questions.length === 0) {
      const tracked = this.messageTracker.getTracked(threadId, trackId);
      if (tracked && tracked.telegramMsgIds[0]) {
        try {
          await this.sendQueue.enqueue(
            () => this.api.deleteMessage(this.chatId!, tracked.telegramMsgIds[0]),
            'edit'
          );
        } catch { /* ok — may already be gone */ }
        this.messageTracker.track(threadId, trackId, [], 'cleared', 'questionnaire');
      }
      return;
    }

    const hashCallback = (sp: string) => this.messageTracker.hashSelector(sp);
    const formatted = formatQuestionnaire(questionnaire, hashCallback);
    if (!formatted.html) return;

    const contentHash = MessageTracker.contentHash(formatted.html + JSON.stringify(formatted.keyboard));
    const tracked = this.messageTracker.getTracked(threadId, trackId);

    if (tracked && !this.messageTracker.hasChanged(threadId, trackId, contentHash)) return;

    try {
      if (tracked && tracked.telegramMsgIds[0]) {
        await this.sendQueue.enqueue(
          () => this.api.editMessageText(this.chatId!, tracked.telegramMsgIds[0], formatted.html, {
            parse_mode: 'HTML',
            reply_markup: formatted.keyboard,
          }),
          'edit'
        );
        this.messageTracker.track(
          threadId, trackId, tracked.telegramMsgIds,
          contentHash, 'questionnaire'
        );
      } else {
        const sent = await this.sendQueue.enqueue(
          () => this.api.sendMessage(this.chatId!, formatted.html, {
            message_thread_id: threadId,
            parse_mode: 'HTML',
            reply_markup: formatted.keyboard,
          }),
          'send'
        );
        this.messageTracker.track(
          threadId, trackId, [sent.message_id],
          contentHash, 'questionnaire'
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('not found') && !msg.includes('not modified')) {
        console.warn('[telegram] Questionnaire error:', msg);
      }
    }
  }

  // --- Typing indicator ---

  private syncTypingIndicator(): void {
    const state = this.stateManager.getCurrentState();
    const active =
      state.agentActivityLive &&
      ['thinking', 'generating', 'running_tool'].includes(state.agentStatus);

    if (active && !this.typingInterval) {
      this.sendTyping();
      this.typingInterval = setInterval(() => this.sendTyping(), TYPING_INTERVAL_MS);
    } else if (!active && this.typingInterval) {
      this.stopTyping();
    }
  }

  private sendTyping(): void {
    if (!this.chatId) return;
    const state = this.stateManager.getCurrentState();
    const threadId = this.topicManager.getActiveThread(
      state.windows, state.activeWindowId, state.chatTabs
    );
    if (!threadId) return;

    this.api.sendChatAction(this.chatId, 'typing', {
      message_thread_id: threadId,
    }).catch(() => {});
  }

  private stopTyping(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }
}
