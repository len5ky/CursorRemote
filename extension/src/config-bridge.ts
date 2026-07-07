import * as vscode from 'vscode';
import { TELEGRAM_BOT_TOKEN_SECRET_KEY } from './secrets.js';

export async function buildEnvFromConfig(
  context: vscode.ExtensionContext,
  licenseKey: string | undefined
): Promise<Record<string, string>> {
  const config = vscode.workspace.getConfiguration('cursorRemote');
  const telegramBotToken = (await context.secrets.get(TELEGRAM_BOT_TOKEN_SECRET_KEY))
    ?? config.get<string>('telegram.botToken', '');
  return {
    CDP_URL: config.get<string>('cdpUrl', 'http://127.0.0.1:9222'),
    SERVER_PORT: String(config.get<number>('serverPort', 3000)),
    SERVER_HOST: config.get<string>('serverHost', '127.0.0.1'),
    POLL_INTERVAL_MS: String(config.get<number>('pollIntervalMs', 500)),
    DEBOUNCE_MS: String(config.get<number>('debounceMs', 300)),
    LOG_LEVEL: config.get<string>('logLevel', 'info'),
    WEBAPP_PASSWORD: config.get<string>('webappPassword', ''),
    WINDOW_TITLE_QUALIFIER: String(config.get<boolean>('windowTitleQualifier', true)),
    TELEGRAM_ENABLED: String(config.get<boolean>('telegram.enabled', false)),
    TELEGRAM_BOT_TOKEN: telegramBotToken,
    TELEGRAM_ALLOWED_USERS: config.get<string>('telegram.allowedUsers', ''),
    TELEGRAM_IMPL: config.get<string>('telegram.impl', 'grammy'),
    LICENSE_KEY: licenseKey ?? '',
    DATA_DIR: context.globalStorageUri.fsPath,
    LOG_FORMAT: 'json',
  };
}
