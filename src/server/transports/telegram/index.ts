import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { TelegramConfig } from '../../types.js';
import type { StateManager } from '../../state-manager.js';
import type { CommandExecutor } from '../../command-executor.js';
import type { CDPBridge } from '../../cdp-bridge.js';
import type { WindowMonitor } from '../../window-monitor.js';
import { BaseTelegramTransport, BOT_COMMANDS } from './base.js';
import type { TelegramApiClient, BotContext, TgKeyboard } from './tg-types.js';
import {
  handleRegister,
  handleCallbackQuery,
  handleTextMessage,
} from './commands.js';

function grammyApiAdapter(bot: Bot): TelegramApiClient {
  return {
    sendMessage: (chatId, text, opts) =>
      bot.api.sendMessage(chatId, text, opts as Parameters<typeof bot.api.sendMessage>[2]),
    editMessageText: (chatId, msgId, text, opts) =>
      bot.api.editMessageText(chatId, msgId, text, opts as Parameters<typeof bot.api.editMessageText>[3]).then(() => {}),
    deleteMessage: (chatId, msgId) =>
      bot.api.deleteMessage(chatId, msgId),
    sendChatAction: (chatId, action, opts) =>
      bot.api.sendChatAction(chatId, action as 'typing', opts).then(() => {}),
    createForumTopic: (chatId, name) =>
      bot.api.createForumTopic(chatId, name),
    editForumTopic: (chatId, threadId, name) =>
      bot.api.editForumTopic(chatId, threadId, { name }).then(() => {}),
    deleteForumTopic: (chatId, threadId) =>
      bot.api.deleteForumTopic(chatId, threadId).then(() => {}),
    setMyCommands: (commands) =>
      bot.api.setMyCommands(commands).then(() => {}),
    getMe: () =>
      bot.api.getMe(),
    getChatMember: (chatId, userId) =>
      bot.api.getChatMember(chatId, userId) as unknown as Promise<{ status: string; [key: string]: unknown }>,
    answerCallbackQuery: (id, opts) =>
      bot.api.raw.answerCallbackQuery({ callback_query_id: id, ...opts }).then(() => {}),
  };
}

function grammyCtxToBotCtx(ctx: import('grammy').Context): BotContext {
  const chat = ctx.chat;
  return {
    from: ctx.from ? { id: ctx.from.id, username: ctx.from.username, first_name: ctx.from.first_name } : undefined,
    chat: chat ? { id: chat.id, type: chat.type, is_forum: (chat as unknown as Record<string, unknown>).is_forum as boolean | undefined } : undefined,
    message: ctx.message ? { text: ctx.message.text, message_thread_id: ctx.message.message_thread_id } : undefined,
    callbackQuery: ctx.callbackQuery ? {
      data: ctx.callbackQuery.data,
      id: ctx.callbackQuery.id,
      message: ctx.callbackQuery.message ? {
        message_thread_id: (ctx.callbackQuery.message as unknown as Record<string, unknown>).message_thread_id as number | undefined,
        message_id: ctx.callbackQuery.message.message_id,
      } : undefined,
    } : undefined,
    match: typeof ctx.match === 'string' ? ctx.match : undefined,
    reply: (text, options) =>
      ctx.reply(text, options as Parameters<typeof ctx.reply>[1]) as Promise<{ message_id: number }>,
    editMessageText: (text, options) =>
      ctx.editMessageText(text, options as Parameters<typeof ctx.editMessageText>[1]).then(() => {}),
    answerCallbackQuery: (options) =>
      ctx.answerCallbackQuery(options as Parameters<typeof ctx.answerCallbackQuery>[0]).then(() => {}),
  };
}

export class TelegramTransport extends BaseTelegramTransport {
  private bot: Bot;

  constructor(
    config: TelegramConfig,
    windowMonitor: WindowMonitor,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    super(config, windowMonitor, stateManager, commandExecutor, cdpBridge);

    const grammyFetch: typeof fetch = (input, init) => {
      if (init?.signal) return fetch(input, init);
      return fetch(input, { ...init, signal: AbortSignal.timeout(30000) });
    };
    this.bot = new Bot(config.botToken, { client: { fetch: grammyFetch } });
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));
    this.api = grammyApiAdapter(this.bot);
    this.setupRouting();
  }

  async start(): Promise<void> {
    this.attachListeners();

    const username = await this.connectAndVerify();
    if (!username) return;

    this.setupStaleTimer();

    try {
      console.log('[telegram] Initializing bot (getMe via Grammy)...');
      await this.bot.init();
      console.log(`[telegram] Bot initialized: @${this.bot.botInfo.username} (id ${this.bot.botInfo.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram] bot.init() failed: ${msg}`);
      return;
    }

    this.api.setMyCommands([...BOT_COMMANDS]).catch(err =>
      console.warn(`[telegram] setMyCommands failed: ${err instanceof Error ? err.message : err}`)
    );

    console.log('[telegram] Starting long-poll...');

    let startFired = false;
    const watchdog = setTimeout(() => {
      if (!startFired) {
        console.warn('[telegram] Long-poll has not connected after 30s — first getUpdates may be hanging');
        console.warn('[telegram] Common causes: another instance racing, network dropping long-poll connections, Telegram rate-limiting');
      }
    }, 30000);

    this.bot.start({
      drop_pending_updates: true,
      onStart: () => {
        startFired = true;
        clearTimeout(watchdog);
        this.onBotConnected();
      },
    }).catch(err => {
      startFired = true;
      clearTimeout(watchdog);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('409') || msg.includes('Conflict')) {
        console.error('[telegram] 409 Conflict — another bot instance took over polling');
        console.error('[telegram] Only one process can long-poll per bot token');
      } else {
        console.error(`[telegram] bot.start() failed: ${msg}`);
      }
    });
  }

  async stop(): Promise<void> {
    this.onStop();
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

  private setupRouting(): void {
    const regDeps = this.buildRegisterDeps();
    this.bot.command('register', (ctx) =>
      handleRegister(grammyCtxToBotCtx(ctx), regDeps)
    );

    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !this.registeredUsers.has(userId)) return;
      const text = ctx.message?.text;
      if (text?.startsWith('/')) {
        const cmd = text.split(/\s/)[0];
        const who = ctx.from?.username ? `@${ctx.from.username}` : String(userId);
        console.log(`[telegram] ${who} → ${cmd}`);
      }
      await next();
    });

    const deps = this.buildCommandDeps();

    for (const { command } of BOT_COMMANDS) {
      if (command === 'register') continue;
      this.bot.command(command, (ctx) =>
        this.dispatchCommand(command, grammyCtxToBotCtx(ctx), deps)
      );
    }

    this.bot.on('callback_query:data', (ctx) =>
      handleCallbackQuery(grammyCtxToBotCtx(ctx), deps)
    );

    this.bot.on('message:text', (ctx) => {
      if (ctx.message.text?.startsWith('/')) return;
      return handleTextMessage(grammyCtxToBotCtx(ctx), deps);
    });

    this.bot.catch((err) => {
      console.error('[telegram] Bot error:', err.message ?? err);
    });
  }
}
