import type { TelegramApiClient, TgKeyboard } from '../telegram/tg-types.js';

const HTTP_TIMEOUT_MS = 30_000;

export class RawTelegramApiClient implements TelegramApiClient {
  private baseUrl: string;

  constructor(botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const resp = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const data = await resp.json() as { ok: boolean; result?: T; description?: string; error_code?: number };
    if (!data.ok) {
      const err = new Error(`Telegram API ${method}: ${data.description ?? 'unknown error'}`) as Error & { error_code?: number };
      err.error_code = data.error_code;
      throw err;
    }
    return data.result as T;
  }

  async sendMessage(chatId: number, text: string, options?: {
    message_thread_id?: number;
    parse_mode?: string;
    reply_markup?: TgKeyboard;
  }): Promise<{ message_id: number }> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (options?.message_thread_id != null) body.message_thread_id = options.message_thread_id;
    if (options?.parse_mode) body.parse_mode = options.parse_mode;
    if (options?.reply_markup) body.reply_markup = options.reply_markup;
    const result = await this.call<{ message_id: number }>('sendMessage', body);
    // Trace every send so we can prove which thread(s) a duplicate landed in.
    const preview = text.replace(/\s+/g, ' ').slice(0, 60);
    console.log(`[telegram-api] send thread=${options?.message_thread_id ?? 'main'} msgId=${result.message_id} text="${preview}"`);
    return result;
  }

  async editMessageText(chatId: number, messageId: number, text: string, options?: {
    parse_mode?: string;
    reply_markup?: TgKeyboard;
  }): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
    if (options?.parse_mode) body.parse_mode = options.parse_mode;
    if (options?.reply_markup) body.reply_markup = options.reply_markup;
    await this.call('editMessageText', body);
  }

  async deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    return this.call<boolean>('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  async sendChatAction(chatId: number, action: string, options?: {
    message_thread_id?: number;
  }): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, action };
    if (options?.message_thread_id != null) body.message_thread_id = options.message_thread_id;
    await this.call('sendChatAction', body);
  }

  async createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number }> {
    return this.call<{ message_thread_id: number }>('createForumTopic', {
      chat_id: chatId,
      name,
    });
  }

  async editForumTopic(chatId: number, threadId: number, name: string): Promise<void> {
    await this.call('editForumTopic', {
      chat_id: chatId,
      message_thread_id: threadId,
      name,
    });
  }

  async deleteForumTopic(chatId: number, threadId: number): Promise<void> {
    await this.call('deleteForumTopic', {
      chat_id: chatId,
      message_thread_id: threadId,
    });
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  async getMe(): Promise<{ id: number; username?: string; is_bot: boolean; first_name: string }> {
    return this.call('getMe');
  }

  async getChatMember(chatId: number, userId: number): Promise<{ status: string; [key: string]: unknown }> {
    return this.call('getChatMember', {
      chat_id: chatId,
      user_id: userId,
    });
  }

  async answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (options?.text) body.text = options.text;
    await this.call('answerCallbackQuery', body);
  }

  async getUpdates(offset: number, timeout: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    const timeoutSignal = AbortSignal.timeout((timeout + 10) * 1000);
    const combined = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const resp = await fetch(`${this.baseUrl}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout,
        allowed_updates: ['message', 'callback_query'],
      }),
      signal: combined,
    });
    const data = await resp.json() as { ok: boolean; result?: TgUpdate[]; description?: string; error_code?: number };
    if (!data.ok) {
      const err = new Error(`getUpdates: ${data.description ?? 'unknown error'}`) as Error & { error_code?: number };
      err.error_code = data.error_code;
      throw err;
    }
    return data.result ?? [];
  }
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string; is_bot?: boolean };
  chat: { id: number; type: string; is_forum?: boolean };
  text?: string;
  message_thread_id?: number;
  date: number;
}

export interface TgCallbackQuery {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: TgMessage;
  data?: string;
}
