import type { TelegramConfig } from '../../types.js';
import type { StateManager } from '../../state-manager.js';
import type { CommandExecutor } from '../../command-executor.js';
import type { CDPBridge } from '../../cdp-bridge.js';
import type { WindowMonitor } from '../../window-monitor.js';
import { BaseTelegramTransport, BOT_COMMANDS } from '../telegram/base.js';
import type { BotContext } from '../telegram/tg-types.js';
import type { CommandDeps, RegisterDeps } from '../telegram/commands.js';
import {
  handleRegister,
  handleCallbackQuery,
  handleTextMessage,
} from '../telegram/commands.js';
import { RawTelegramApiClient, type TgUpdate } from './raw-api.js';

const POLL_TIMEOUT_S = 30;
const POLL_ERROR_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RawTelegramTransport extends BaseTelegramTransport {
  private rawApi: RawTelegramApiClient;
  private running = false;
  private pollAbort: AbortController | null = null;
  private deps!: CommandDeps;
  private regDeps!: RegisterDeps;

  constructor(
    config: TelegramConfig,
    windowMonitor: WindowMonitor,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    super(config, windowMonitor, stateManager, commandExecutor, cdpBridge);
    this.rawApi = new RawTelegramApiClient(config.botToken);
    this.api = this.rawApi;
  }

  async start(): Promise<void> {
    this.attachListeners();

    const username = await this.connectAndVerify();
    if (!username) return;

    this.setupStaleTimer();

    try {
      console.log('[telegram-raw] Verifying bot identity...');
      const me = await this.rawApi.getMe();
      console.log(`[telegram-raw] Bot: @${me.username} (id ${me.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[telegram-raw] getMe failed: ${msg}`);
      return;
    }

    this.rawApi.setMyCommands([...BOT_COMMANDS]).catch(err =>
      console.warn(`[telegram-raw] setMyCommands failed: ${err instanceof Error ? err.message : err}`)
    );

    this.deps = this.buildCommandDeps();
    this.regDeps = this.buildRegisterDeps();

    this.running = true;
    this.onBotConnected();

    this.pollLoop().catch(err => {
      if (this.running) {
        console.error('[telegram-raw] Poll loop crashed:', err);
      }
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    this.onStop();
    console.log('[telegram-raw] Bot stopped');
  }

  // --- Long-poll loop ---

  private async pollLoop(): Promise<void> {
    let offset = -1;
    console.log('[telegram-raw] Starting long-poll loop...');

    // Drop stale pending updates (equivalent to Grammy's drop_pending_updates: true).
    // offset=-1 means "give me only the latest update id so I can skip everything before it".
    try {
      const stale = await this.rawApi.getUpdates(-1, 0);
      if (stale.length > 0) {
        offset = stale[stale.length - 1].update_id + 1;
        console.log(`[telegram-raw] Dropped ${stale.length} pending update(s), resuming from offset ${offset}`);
      } else {
        offset = 0;
      }
    } catch {
      offset = 0;
    }

    while (this.running) {
      this.pollAbort = new AbortController();
      try {
        const updates = await this.rawApi.getUpdates(offset, POLL_TIMEOUT_S, this.pollAbort.signal);
        for (const update of updates) {
          if (update.update_id >= offset) {
            offset = update.update_id + 1;
          }
          try {
            await this.dispatchUpdate(update);
          } catch (err) {
            console.error('[telegram-raw] Update dispatch error:', err instanceof Error ? err.message : err);
          }
        }
      } catch (err) {
        if (!this.running) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('abort')) break;
        const code = (err as Record<string, unknown>).error_code;
        if (code === 409) {
          console.error('[telegram-raw] 409 Conflict — another bot instance took over polling');
          this.running = false;
          break;
        }
        console.warn(`[telegram-raw] Poll error: ${msg}`);
        await sleep(POLL_ERROR_BACKOFF_MS);
      } finally {
        this.pollAbort = null;
      }
    }

    console.log('[telegram-raw] Poll loop ended');
  }

  // --- Update dispatch ---

  private async dispatchUpdate(update: TgUpdate): Promise<void> {
    if (update.message?.text) {
      const text = update.message.text;
      const ctx = this.makeContext(update);

      if (text.startsWith('/')) {
        const [cmdPart, ...rest] = text.split(/\s+/);
        const cmd = cmdPart.slice(1).split('@')[0];
        ctx.match = rest.join(' ');

        if (cmd === 'register') {
          await handleRegister(ctx, this.regDeps);
          return;
        }

        const userId = update.message.from?.id;
        if (!userId || !this.registeredUsers.has(userId)) return;

        const who = update.message.from?.username ? `@${update.message.from.username}` : String(userId);
        console.log(`[telegram-raw] ${who} → /${cmd}`);

        await this.dispatchCommand(cmd, ctx, this.deps);
      } else {
        const userId = update.message.from?.id;
        if (!userId || !this.registeredUsers.has(userId)) return;
        await handleTextMessage(ctx, this.deps);
      }
    } else if (update.callback_query) {
      const userId = update.callback_query.from?.id;
      if (!userId || !this.registeredUsers.has(userId)) return;
      const ctx = this.makeContext(update);
      await handleCallbackQuery(ctx, this.deps);
    }
  }

  private makeContext(update: TgUpdate): BotContext {
    const msg = update.message;
    const cbq = update.callback_query;
    const chatId = msg?.chat?.id ?? cbq?.message?.chat?.id;
    const threadId = msg?.message_thread_id ?? cbq?.message?.message_thread_id;
    const api = this.rawApi;

    return {
      from: msg?.from ?? (cbq ? { id: cbq.from.id, username: cbq.from.username, first_name: cbq.from.first_name } : undefined),
      chat: msg?.chat ?? cbq?.message?.chat,
      message: msg ? { text: msg.text, message_thread_id: msg.message_thread_id } : undefined,
      callbackQuery: cbq ? {
        data: cbq.data,
        id: cbq.id,
        message: cbq.message ? {
          message_thread_id: cbq.message.message_thread_id,
          message_id: cbq.message.message_id,
        } : undefined,
      } : undefined,
      match: undefined,
      async reply(text, options) {
        return api.sendMessage(chatId!, text, {
          message_thread_id: options?.message_thread_id ?? threadId,
          parse_mode: options?.parse_mode,
          reply_markup: options?.reply_markup,
        });
      },
      async editMessageText(text, options) {
        const editMsgId = cbq?.message?.message_id;
        if (!chatId || !editMsgId) return;
        await api.editMessageText(chatId, editMsgId, text, options);
      },
      async answerCallbackQuery(options) {
        if (!cbq?.id) return;
        await api.answerCallbackQuery(cbq.id, options);
      },
    };
  }
}
