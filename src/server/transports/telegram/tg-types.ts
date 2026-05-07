export interface TgInlineButton {
  text: string;
  callback_data: string;
}

export interface TgKeyboard {
  inline_keyboard: TgInlineButton[][];
}

export class TgKeyboardBuilder {
  private rows: TgInlineButton[][] = [[]];

  text(label: string, data: string): this {
    this.rows[this.rows.length - 1].push({ text: label, callback_data: data });
    return this;
  }

  row(): this {
    if (this.rows[this.rows.length - 1].length > 0) this.rows.push([]);
    return this;
  }

  build(): TgKeyboard {
    return { inline_keyboard: this.rows.filter(r => r.length > 0) };
  }
}

export function tgKeyboard(): TgKeyboardBuilder {
  return new TgKeyboardBuilder();
}

export interface BotContext {
  from?: { id: number; username?: string; first_name?: string };
  chat?: { id: number; type: string; is_forum?: boolean };
  message?: { text?: string; message_thread_id?: number };
  callbackQuery?: {
    data?: string;
    id: string;
    message?: { message_thread_id?: number; message_id?: number };
  };
  match?: string;
  reply(text: string, options?: {
    parse_mode?: string;
    reply_markup?: TgKeyboard;
    message_thread_id?: number;
  }): Promise<{ message_id: number }>;
  editMessageText(text: string, options?: {
    parse_mode?: string;
    reply_markup?: TgKeyboard;
  }): Promise<void>;
  answerCallbackQuery(options?: { text?: string }): Promise<void>;
}

export interface TelegramApiClient {
  sendMessage(chatId: number, text: string, options?: {
    message_thread_id?: number;
    parse_mode?: string;
    reply_markup?: TgKeyboard;
  }): Promise<{ message_id: number }>;
  editMessageText(chatId: number, messageId: number, text: string, options?: {
    parse_mode?: string;
    reply_markup?: TgKeyboard;
  }): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<boolean>;
  sendChatAction(chatId: number, action: string, options?: {
    message_thread_id?: number;
  }): Promise<void>;
  createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number }>;
  editForumTopic(chatId: number, threadId: number, name: string): Promise<void>;
  deleteForumTopic(chatId: number, threadId: number): Promise<void>;
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
  getMe(): Promise<{ id: number; username?: string; is_bot: boolean; first_name: string }>;
  getChatMember(chatId: number, userId: number): Promise<{ status: string; [key: string]: unknown }>;
  answerCallbackQuery(callbackQueryId: string, options?: { text?: string }): Promise<void>;
}
