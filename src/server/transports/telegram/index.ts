import { readFileSync, writeFileSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
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
  formatApprovals,
  splitMessage,
} from './formatter.js';
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

export class TelegramTransport implements Transport {
  readonly name = 'telegram';

  private bot: Bot;
  private config: TelegramConfig;
  private stateManager: StateManager;
  private commandExecutor: CommandExecutor;
  private cdpBridge: CDPBridge;
  private windowMonitor: WindowMonitor;
  private topicManager: TopicManager;
  private messageTracker: MessageTracker;
  private sendQueue: SendQueue;

  private typingInterval: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private groupId: number | undefined;
  private seenThreads = new Set<number>();
  private processing = new Set<string>();
  private pendingSnapshots = new Map<string, WindowSnapshot>();
  private syncEnabled = false;
  private creatingTopic = new Set<string>();
  private authState: AuthState;
  private registeredUsers: Set<number>;

  private get chatId(): number | undefined {
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
    this.sendQueue = new SendQueue({ sendDelayMs: 500, editDelayMs: 100, maxRetries: 3, maxQueueSize: 500 });
    this.bot = new Bot(config.botToken, { client: { fetch } });
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

    this.authState = this.loadAuth();
    if (config.preRegisteredUsers.length > 0) {
      this.registeredUsers = new Set(config.preRegisteredUsers);
      console.log(`[telegram] Using TELEGRAM_ALLOWED_USERS: ${config.preRegisteredUsers.join(', ')}`);
    } else {
      this.registeredUsers = new Set(this.authState.registeredUsers.map(u => u.id));
    }
    this.loadSyncState();
    this.setupBot();
  }

  async start(): Promise<void> {
    this.windowMonitor.on('window:update', this.onWindowUpdate);
    this.stateManager.on('state:patch', this.onStatePatch);
    this.stateManager.on('connection:changed', this.onConnectionChanged);

    this.bot.api.setMyCommands([
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
    ]).catch(err => console.warn(`[telegram] setMyCommands failed: ${err instanceof Error ? err.message : err}`));

    const maskedToken = this.config.botToken.slice(0, 6) + '...' + this.config.botToken.slice(-4);
    console.log(`[telegram] Starting bot (token: ${maskedToken})...`);

    const apiBase = `https://api.telegram.org/bot${this.config.botToken}`;

    try {
      const resp = await fetch(`${apiBase}/getMe`, { signal: AbortSignal.timeout(10000) });
      const data = await resp.json() as { ok: boolean; result?: { username?: string } };
      if (!data.ok) {
        console.error(`[telegram] getMe returned ok=false — bot token may be invalid`);
        return;
      }
      console.log(`[telegram] API reachable — bot: @${data.result?.username}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] Cannot reach Telegram API: ${msg}`);
      try {
        await fetch('https://www.google.com', { signal: AbortSignal.timeout(5000) });
        console.error('[telegram] google.com reachable — issue is Telegram-specific (DNS/blocked/token)');
      } catch {
        console.error('[telegram] No outbound HTTPS from this process. Check proxy/firewall for Node.js.');
      }
      return;
    }

    try {
      await fetch(`${apiBase}/deleteWebhook`, { signal: AbortSignal.timeout(5000) });
      console.log('[telegram] Cleared any stale webhook/session');
    } catch {
      // non-fatal
    }

    this.bot.start({
      onStart: () => {
        console.log(`[telegram] Bot connected (sync: ${this.syncEnabled ? 'on' : 'off'})`);
        this.started = true;
      },
    }).catch(err => {
      console.error(`[telegram] Bot.start() failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    this.windowMonitor.off('window:update', this.onWindowUpdate);
    this.stateManager.off('state:patch', this.onStatePatch);
    this.stateManager.off('connection:changed', this.onConnectionChanged);
    this.stopTyping();
    this.messageTracker.flush();
    try {
      await Promise.race([
        this.bot.stop(),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // best-effort
    }
    console.log('[telegram] Bot stopped');
  }

  private setupBot(): void {
    // /register is open to anyone — token validates
    this.bot.command('register', (ctx) => {
      return handleRegister(ctx, {
        authState: this.authState,
        registeredUsers: this.registeredUsers,
        registerUser: (id, username, firstName) => this.registerUser(id, username, firstName),
      });
    });

    // All other commands require registration
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.registeredUsers.has(userId)) return;
      await next();
    });

    const self = this;
    const deps = {
      bot: this.bot,
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

    this.bot.command('sync', (ctx) => handleSync(ctx, deps));
    this.bot.command('sync_all', (ctx) => handleSyncAll(ctx, deps));
    this.bot.command('unsync', (ctx) => handleUnsync(ctx, deps));
    this.bot.command('cleanup', (ctx) => handleCleanup(ctx, deps));
    this.bot.command('purge', (ctx) => handlePurge(ctx, deps));
    this.bot.command('status', (ctx) => handleStatus(ctx, deps));
    this.bot.command('history', (ctx) => handleHistory(ctx, deps));
    this.bot.command('mode', (ctx) => handleMode(ctx, deps));
    this.bot.command('model', (ctx) => handleModel(ctx, deps));
    this.bot.command('plan', (ctx) => handlePlanCommand(ctx, deps));
    this.bot.command('agent', (ctx) => handleAgentCommand(ctx, deps));

    this.bot.on('callback_query:data', (ctx) => handleCallbackQuery(ctx, deps));

    this.bot.on('message:text', (ctx) => {
      if (ctx.message.text?.startsWith('/')) return;
      return handleTextMessage(ctx, deps);
    });

    this.bot.catch((err) => {
      console.error('[telegram] Bot error:', err.message ?? err);
    });
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

  /** Clear all in-memory and persisted state (topics, messages, processing queues). */
  resetAllState(): void {
    this.seenThreads.clear();
    this.creatingTopic.clear();
    this.processing.clear();
    this.pendingSnapshots.clear();
    this.topicManager.clearAll();
    this.messageTracker.clearAll();
    console.log('[telegram] All state reset');
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

    if (patch.agentStatus) {
      this.updateTypingIndicator(patch.agentStatus);
    }
  };

  private onConnectionChanged = (connected: boolean): void => {
    if (!this.started || !this.syncEnabled || !this.chatId) return;
    if (this.windowMonitor.isCycling) return;

    const text = connected
      ? '✅ Reconnected to Cursor IDE'
      : '⚠️ Disconnected from Cursor IDE';

    this.sendQueue.enqueue(
      () => this.bot.api.sendMessage(this.chatId!, text),
      'send'
    ).catch(() => {});
  };

  // --- Message processing ---

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

    // Guard: check if this tab is already mapped to a DIFFERENT window.
    // This catches cross-window pollution from DOM extraction returning
    // tabs that belong to another project's window.
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

          // Edit first part
          try {
            await this.sendQueue.enqueue(
              () => this.bot.api.editMessageText(this.chatId!, mainMsgId, parts[0], {
                parse_mode: 'HTML',
                reply_markup: parts.length === 1 ? formatted.keyboard : undefined,
              }),
              'edit'
            );
          } catch (htmlErr) {
            const htmlMsg = htmlErr instanceof Error ? htmlErr.message : String(htmlErr);
            if (htmlMsg.includes('parse entities') || htmlMsg.includes('start tag')) {
              await this.sendQueue.enqueue(
                () => this.bot.api.editMessageText(this.chatId!, mainMsgId, parts[0].replace(/<[^>]*>/g, ''), {
                  reply_markup: parts.length === 1 ? formatted.keyboard : undefined,
                }),
                'edit'
              );
            } else {
              throw htmlErr;
            }
          }

          // Send additional parts if message grew
          for (let i = 1; i < parts.length; i++) {
            if (allMsgIds[i]) {
              // Edit existing continuation
              try {
                await this.sendQueue.enqueue(
                  () => this.bot.api.editMessageText(this.chatId!, allMsgIds[i], parts[i], {
                    parse_mode: 'HTML',
                    reply_markup: i === parts.length - 1 ? formatted.keyboard : undefined,
                  }),
                  'edit'
                );
              } catch { /* ok */ }
            } else {
              // Send new continuation
              try {
                const sent = await this.sendQueue.enqueue(
                  () => this.bot.api.sendMessage(this.chatId!, parts[i], {
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
        try {
          const parts = splitMessage(formatted.html);
          const msgIds: number[] = [];

          for (let i = 0; i < parts.length; i++) {
            const isLast = i === parts.length - 1;
            let sent;
            try {
              sent = await this.sendQueue.enqueue(
                () => this.bot.api.sendMessage(this.chatId!, parts[i], {
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
                  () => this.bot.api.sendMessage(this.chatId!, parts[i].replace(/<[^>]*>/g, ''), {
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
    }
  }

  /** Find any existing mapping for a tab title across all windows. */
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
      const result = await this.bot.api.createForumTopic(this.chatId, topicName);
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

    const approvalTrackId = `approval-${approvals[0].id}`;
    const tracked = this.messageTracker.getTracked(threadId, approvalTrackId);

    try {
      if (tracked && tracked.telegramMsgIds[0]) {
        await this.sendQueue.enqueue(
          () => this.bot.api.editMessageText(this.chatId!, tracked.telegramMsgIds[0], formatted.html, {
            parse_mode: 'HTML',
            reply_markup: formatted.keyboard,
          }),
          'edit'
        );
      } else {
        const sent = await this.sendQueue.enqueue(
          () => this.bot.api.sendMessage(this.chatId!, formatted.html, {
            message_thread_id: threadId,
            parse_mode: 'HTML',
            reply_markup: formatted.keyboard,
          }),
          'send'
        );
        this.messageTracker.track(
          threadId, approvalTrackId, [sent.message_id],
          MessageTracker.contentHash(formatted.html), 'approval'
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('not found')) {
        console.warn('[telegram] Approval error:', msg);
      }
    }
  }

  // --- Typing indicator ---

  private updateTypingIndicator(status: string): void {
    const active = ['thinking', 'generating', 'running_tool'].includes(status);

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

    this.bot.api.sendChatAction(this.chatId, 'typing', {
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
