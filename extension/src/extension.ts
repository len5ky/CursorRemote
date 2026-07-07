import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { createOutputChannel, type UnifiedOutputChannel } from './output-channel.js';
import { createStatusBar } from './status-bar.js';
import { ServerManager } from './server-manager.js';
import { LicenseManager } from './license-manager.js';
import { StatusTreeView } from './tree-view.js';
import { SetupPanel } from './setup-panel.js';
import { TELEGRAM_BOT_TOKEN_SECRET_KEY } from './secrets.js';

let serverManager: ServerManager | undefined;

async function ensurePassword(): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorRemote');
  const current = config.get<string>('webappPassword', '');
  if (current) return;

  const generated = randomBytes(16).toString('base64url');
  await config.update('webappPassword', generated, vscode.ConfigurationTarget.Global);

  // Fire-and-forget — don't block activate() waiting for user interaction
  vscode.window.showInformationMessage(
    `CursorRemote: A web client password has been generated: ${generated}`,
    'Copy to Clipboard',
    'Open Settings'
  ).then(action => {
    if (action === 'Copy to Clipboard') {
      vscode.env.clipboard.writeText(generated);
    } else if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'cursorRemote.webappPassword');
    }
  });
}

async function migrateTelegramBotToken(
  context: vscode.ExtensionContext,
  outputChannel: UnifiedOutputChannel
): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorRemote');
  const legacy = config.get<string>('telegram.botToken', '');
  if (!legacy.trim()) return;

  try {
    await context.secrets.store(TELEGRAM_BOT_TOKEN_SECRET_KEY, legacy);
    const stored = await context.secrets.get(TELEGRAM_BOT_TOKEN_SECRET_KEY);
    if (stored === legacy) {
      await config.update('telegram.botToken', undefined, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        'CursorRemote: your Telegram bot token was moved to secure storage.'
      );
    }
  } catch (err) {
    outputChannel.warn(`Telegram bot token migration failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = createOutputChannel();

  const statusBarItem = createStatusBar(context);

  const licenseManager = new LicenseManager(context, () => {
    if (serverManager && serverManager.serverState === 'stopped') {
      serverManager.start();
    }
  });

  await migrateTelegramBotToken(context, outputChannel);

  serverManager = new ServerManager(
    context,
    outputChannel,
    statusBarItem,
    () => licenseManager.getKey()
  );

  serverManager.startDirWatcher();

  const extensionVersion = context.extension.packageJSON?.version ?? 'unknown';
  const treeView = new StatusTreeView(serverManager, licenseManager, extensionVersion);

  context.subscriptions.push(
    outputChannel,
    vscode.window.registerTreeDataProvider('cursorRemote.status', treeView),
    vscode.commands.registerCommand('cursorRemote.start', () => serverManager!.start()),
    vscode.commands.registerCommand('cursorRemote.stop', () => serverManager!.stop(true)),
    vscode.commands.registerCommand('cursorRemote.restart', () => serverManager!.restart()),
    vscode.commands.registerCommand('cursorRemote.openWebClient', () => serverManager!.openWebClient()),
    vscode.commands.registerCommand('cursorRemote.showLogs', () => outputChannel.show()),
    vscode.commands.registerCommand('cursorRemote.enterLicenseKey', async () => {
      await licenseManager.promptForKey();
      treeView.refresh();
    }),
    vscode.commands.registerCommand('cursorRemote.buyLicense', () => licenseManager.openBuyLink()),
    vscode.commands.registerCommand('cursorRemote.clearLicenseKey', async () => {
      await licenseManager.clearKey();
      treeView.refresh();
    }),
    vscode.commands.registerCommand('cursorRemote.openSetup', () => SetupPanel.createOrShow(context)),
  );

  ensurePassword().catch(err => {
    outputChannel.warn(`Password auto-generation failed: ${err}`);
  });

  const config = vscode.workspace.getConfiguration('cursorRemote');
  if (config.get<boolean>('autoStart', true)) {
    licenseManager.checkLicense().then(valid => {
      if (valid) {
        serverManager!.start();
      }
    });
  }
}

export async function deactivate(): Promise<void> {
  if (serverManager) {
    await serverManager.stop();
    serverManager.dispose();
  }
}
