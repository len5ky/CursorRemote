import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface TelegramAuth {
  token: string;
  registeredUsers: { id: number; username?: string; firstName?: string; registeredAt?: string }[];
}

function loadTelegramAuth(context: vscode.ExtensionContext): TelegramAuth | null {
  const dataDir = context.globalStorageUri.fsPath;
  const authPath = join(dataDir, 'telegram-auth.json');
  try {
    if (existsSync(authPath)) {
      return JSON.parse(readFileSync(authPath, 'utf-8'));
    }
  } catch { /* not available */ }
  return null;
}

export class SetupPanel {
  public static currentPanel: SetupPanel | undefined;
  private static readonly viewType = 'cursorRemote.setup';
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private disposables: vscode.Disposable[] = [];
  private _disposed = false;

  public static createOrShow(context: vscode.ExtensionContext): void {
    if (SetupPanel.currentPanel) {
      SetupPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      SetupPanel.currentPanel.updateWebview();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SetupPanel.viewType,
      'CursorRemote Setup',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    SetupPanel.currentPanel = new SetupPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    this.updateWebview();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );
  }

  private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    switch (msg.type) {
      case 'setNetworking': {
        const mode = msg.mode as string;
        if (mode === 'localhost') {
          await config.update('serverHost', '127.0.0.1', vscode.ConfigurationTarget.Global);
        } else if (mode === 'custom') {
          const addr = (msg.address as string || '').trim();
          if (addr) {
            await config.update('serverHost', addr, vscode.ConfigurationTarget.Global);
          }
        } else {
          await config.update('serverHost', '0.0.0.0', vscode.ConfigurationTarget.Global);
        }
        this.updateWebview();
        break;
      }
      case 'copySettingsFilter': {
        vscode.env.clipboard.writeText('@ext:cursor-remote.cursor-remote');
        vscode.window.showInformationMessage('Filter copied — paste it in the Settings search bar.');
        break;
      }
      case 'copyPassword': {
        const pw = config.get<string>('webappPassword', '');
        if (pw) {
          await vscode.env.clipboard.writeText(pw);
          vscode.window.showInformationMessage('Password copied to clipboard.');
        }
        break;
      }
      case 'savePassword': {
        const newPw = (msg.password as string).trim();
        await config.update('webappPassword', newPw, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          newPw ? 'Password updated. Restart the server for changes to take effect.' : 'Password cleared.'
        );
        this.updateWebview();
        break;
      }
      case 'saveTelegramToken': {
        const token = (msg.token as string).trim();
        if (token) {
          await config.update('telegram.botToken', token, vscode.ConfigurationTarget.Global);
          await config.update('telegram.enabled', true, vscode.ConfigurationTarget.Global);
          this.updateWebview();
        }
        break;
      }
      case 'openExternal': {
        const url = msg.url as string;
        vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'restartServer': {
        vscode.commands.executeCommand('cursorRemote.restart');
        break;
      }
      case 'refresh': {
        this.updateWebview();
        break;
      }
    }
  }

  private updateWebview(): void {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    const telegramAuth = loadTelegramAuth(this.context);
    const state = {
      serverHost: config.get<string>('serverHost', '127.0.0.1'),
      serverPort: config.get<number>('serverPort', 3000),
      webappPassword: config.get<string>('webappPassword', ''),
      telegramEnabled: config.get<boolean>('telegram.enabled', false),
      telegramBotToken: config.get<string>('telegram.botToken', ''),
      telegramRegisterToken: telegramAuth?.token ?? '',
      telegramRegisteredUsers: telegramAuth?.registeredUsers ?? [],
    };
    this.panel.webview.html = getWebviewContent(state);
  }

  private dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    SetupPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

interface PanelState {
  serverHost: string;
  serverPort: number;
  webappPassword: string;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramRegisterToken: string;
  telegramRegisteredUsers: { id: number; username?: string; firstName?: string; registeredAt?: string }[];
}

function getWebviewContent(state: PanelState): string {
  const networkMode = state.serverHost === '127.0.0.1' ? 'localhost'
    : state.serverHost === '0.0.0.0' ? 'lan' : 'custom';
  const customAddress = networkMode === 'custom' ? state.serverHost : '';
  const hasBotToken = !!state.telegramBotToken;
  const maskedToken = hasBotToken
    ? state.telegramBotToken.slice(0, 6) + '...' + state.telegramBotToken.slice(-4)
    : '';

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CursorRemote Setup</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, var(--vscode-widget-border, #444));
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border, var(--border));
      --success: var(--vscode-testing-iconPassed, #89d185);
      --warn: var(--vscode-editorWarning-foreground, #cca700);
      --link: var(--vscode-textLink-foreground);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      background: var(--bg);
      color: var(--fg);
      padding: 20px 28px;
      line-height: 1.5;
    }
    h1 {
      font-size: 1.6em;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .subtitle {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
    }

    /* Tabs */
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
      gap: 0;
    }
    .tab {
      padding: 8px 20px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      color: var(--vscode-descriptionForeground);
      transition: color 0.15s, border-color 0.15s;
      user-select: none;
    }
    .tab:hover { color: var(--fg); }
    .tab.active {
      color: var(--fg);
      border-bottom-color: var(--btn-bg);
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Cards */
    .card {
      background: var(--vscode-sideBar-background, var(--bg));
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px 20px;
      margin-bottom: 16px;
    }
    .card h3 {
      font-size: 1.05em;
      margin-bottom: 8px;
    }
    .card p { margin-bottom: 8px; }

    /* Radio options */
    .radio-group { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
    .radio-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .radio-option:hover { border-color: var(--btn-bg); }
    .radio-option.selected {
      border-color: var(--btn-bg);
      background: color-mix(in srgb, var(--btn-bg) 10%, transparent);
    }
    .radio-option input { margin-top: 3px; accent-color: var(--btn-bg); }
    .radio-label strong { display: block; margin-bottom: 2px; }
    .radio-label span { color: var(--vscode-descriptionForeground); font-size: 0.92em; }

    /* Buttons */
    button {
      font-family: inherit;
      font-size: inherit;
      padding: 6px 14px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      color: var(--btn-fg);
      background: var(--btn-bg);
      transition: background 0.15s;
    }
    button:hover { background: var(--btn-hover); }
    button.secondary {
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
    }
    button.secondary:hover { opacity: 0.85; }

    /* Input fields */
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 6px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: inherit;
      border: 1px solid var(--input-border);
      border-radius: 4px;
      background: var(--input-bg);
      color: var(--input-fg);
      outline: none;
    }
    input:focus { border-color: var(--btn-bg); }

    /* Password display */
    .password-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin: 8px 0;
    }
    .password-row code {
      flex: 1;
      padding: 6px 10px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      word-break: break-all;
    }

    /* Status badge */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.85em;
      font-weight: 500;
    }
    .badge.done { background: color-mix(in srgb, var(--success) 20%, transparent); color: var(--success); }
    .badge.pending { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }

    /* Wizard steps */
    .step {
      padding: 14px 0;
      border-bottom: 1px solid var(--border);
    }
    .step:last-child { border-bottom: none; }
    .step-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .step-num {
      width: 26px; height: 26px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 600;
      font-size: 0.9em;
      background: var(--btn-bg);
      color: var(--btn-fg);
      flex-shrink: 0;
    }
    .step-num.done { background: var(--success); }

    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
    .info-text { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
    .mt { margin-top: 12px; }
  </style>
</head>
<body>
  <h1>CursorRemote Setup</h1>
  <p class="subtitle">Configure networking and Telegram integration. Access Cursor remotely from any browser on your phone, tablet, or another computer.</p>

  <div class="tabs">
    <div class="tab active" data-tab="networking">Networking</div>
    <div class="tab" data-tab="telegram">Telegram</div>
  </div>

  <!-- Networking Tab -->
  <div id="tab-networking" class="tab-content active">
    <div class="card">
      <h3>Server Bind Address</h3>
      <p>Choose how the server is exposed so you can connect from a browser on another device.</p>

      <div class="radio-group">
        <label class="radio-option ${networkMode === 'localhost' ? 'selected' : ''}">
          <input type="radio" name="netMode" value="localhost" ${networkMode === 'localhost' ? 'checked' : ''} />
          <div class="radio-label">
            <strong>Localhost only (no remote access)</strong>
            <span>Binds to 127.0.0.1 — only accessible from a browser on this machine.</span>
          </div>
        </label>
        <label class="radio-option ${networkMode === 'lan' ? 'selected' : ''}">
          <input type="radio" name="netMode" value="lan" ${networkMode === 'lan' ? 'checked' : ''} />
          <div class="radio-label">
            <strong>LAN access (all interfaces)</strong>
            <span>Binds to 0.0.0.0 — accessible from any browser on your local network. Password required.</span>
          </div>
        </label>
        <label class="radio-option ${networkMode === 'custom' ? 'selected' : ''}">
          <input type="radio" name="netMode" value="custom" ${networkMode === 'custom' ? 'checked' : ''} />
          <div class="radio-label">
            <strong>Specific address (Tailscale / custom)</strong>
            <span>Bind to a specific IP — useful for <a href="#" onclick="event.stopPropagation(); sendMsg({type:'openExternal',url:'https://tailscale.com/'})">Tailscale</a> or a particular network interface.</span>
            <div class="custom-addr-row" style="margin-top: 8px; ${networkMode === 'custom' ? '' : 'display:none;'}">
              <input type="text" id="customAddress" placeholder="e.g. 100.64.0.1" value="${escapeHtml(customAddress)}" style="width: 200px;" />
            </div>
          </div>
        </label>
      </div>

      <div class="actions">
        <button id="saveNetworking">Save &amp; Restart</button>
      </div>

      <p class="info-text mt">
        Using Tailscale? See the <a href="#" onclick="sendMsg({type:'openExternal',url:'https://github.com/len5ky/CursorRemote/blob/main/docs/tailscale-setup.md'})">setup guide</a> for details.
      </p>
    </div>

    <div class="card">
      <h3>Web Client Password</h3>
      <p>Enter this password in your browser when connecting from another device.</p>
      <div class="password-row">
        <input type="text" id="passwordInput" value="${escapeHtml(state.webappPassword)}" placeholder="Enter a password" style="flex:1;" />
        <button class="secondary" id="copyPassword">Copy</button>
        <button id="savePassword">Save</button>
      </div>
      <p class="info-text mt">
        Open <strong>http://${escapeHtml(state.serverHost === '0.0.0.0' ? '&lt;your-ip&gt;' : state.serverHost)}:${state.serverPort}</strong> in any browser to connect.
      </p>
    </div>
  </div>

  <!-- Telegram Tab -->
  <div id="tab-telegram" class="tab-content">

    <div class="step">
      <div class="step-header">
        <div class="step-num ${hasBotToken ? 'done' : ''}">1</div>
        <strong>Create a Telegram Bot</strong>
        <span class="badge ${hasBotToken ? 'done' : 'pending'}">${hasBotToken ? 'Done' : 'Pending'}</span>
      </div>
      <p>Open <a href="#" onclick="sendMsg({type:'openExternal',url:'https://t.me/BotFather'})">@BotFather</a> in Telegram and create a new bot with <code>/newbot</code>. Paste the token below.</p>
      ${hasBotToken
        ? `<p class="info-text mt">Token: <code>${escapeHtml(maskedToken)}</code></p>`
        : `<div class="mt">
            <input type="text" id="botTokenInput" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
            <div class="actions">
              <button id="saveToken">Save Token</button>
            </div>
          </div>`
      }
    </div>

    <div class="step">
      <div class="step-header">
        <div class="step-num">2</div>
        <strong>Create a Supergroup</strong>
      </div>
      <p>Create a new Telegram group, then:</p>
      <ol style="margin: 8px 0 0 20px;">
        <li>Open group settings and enable <strong>Topics</strong></li>
        <li>Add your bot as an <strong>administrator</strong> with "Manage topics" permission</li>
      </ol>
    </div>

    <div class="step">
      <div class="step-header">
        <div class="step-num ${state.telegramRegisteredUsers.length > 0 ? 'done' : ''}">3</div>
        <strong>Register</strong>
        <span class="badge ${state.telegramRegisteredUsers.length > 0 ? 'done' : 'pending'}">${state.telegramRegisteredUsers.length > 0 ? 'Done' : 'Pending'}</span>
      </div>
      ${state.telegramRegisteredUsers.length > 0
        ? `<p>Registered user(s): <strong>${escapeHtml(state.telegramRegisteredUsers.map(u => u.username ? '@' + u.username : u.firstName ?? String(u.id)).join(', '))}</strong></p>
           <p class="info-text mt">To register a different user, send this in your Telegram group:</p>`
        : `<p>Send this command in your Telegram group to register:</p>`}
      ${state.telegramRegisterToken
        ? `<div class="password-row" style="margin:8px 0;">
            <code style="flex:1; padding:8px;">/register ${escapeHtml(state.telegramRegisterToken)}</code>
            <button class="secondary" onclick="navigator.clipboard.writeText('/register ${escapeHtml(state.telegramRegisterToken)}')">Copy</button>
          </div>`
        : `<p class="info-text">Start the server to generate a registration token.</p>`}
    </div>

    <div class="step">
      <div class="step-header">
        <div class="step-num">4</div>
        <strong>Sync</strong>
      </div>
      <p>After registration succeeds, send <code>/sync</code> in the group to create Cursor window topics. You're all set!</p>
    </div>

  </div>

  <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border);">
    <p class="info-text">For all settings, press <strong>Ctrl+,</strong> (or <strong>Cmd+,</strong>) and search <code>@ext:cursor-remote.cursor-remote</code>.
    <button class="secondary" style="margin-left: 8px; display: inline; padding: 3px 10px; font-size: 0.9em;" id="copySettingsFilter">Copy filter</button></p>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function sendMsg(msg) { vscode.postMessage(msg); }

    // Tab switching
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    // Radio selection visual feedback + show/hide custom address field
    document.querySelectorAll('input[name="netMode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        document.querySelectorAll('.radio-option').forEach(o => o.classList.remove('selected'));
        radio.closest('.radio-option').classList.add('selected');
        const customRow = document.querySelector('.custom-addr-row');
        if (customRow) customRow.style.display = radio.value === 'custom' ? '' : 'none';
      });
    });

    // Save networking
    document.getElementById('saveNetworking')?.addEventListener('click', () => {
      const mode = document.querySelector('input[name="netMode"]:checked')?.value;
      const msg = { type: 'setNetworking', mode };
      if (mode === 'custom') {
        msg.address = document.getElementById('customAddress')?.value || '';
      }
      sendMsg(msg);
      setTimeout(() => sendMsg({ type: 'restartServer' }), 500);
    });

    // Copy password from input field
    document.getElementById('copyPassword')?.addEventListener('click', () => {
      const pw = document.getElementById('passwordInput')?.value;
      if (pw) {
        navigator.clipboard.writeText(pw).then(() => {
          sendMsg({ type: 'copyPassword' });
        }).catch(() => {
          sendMsg({ type: 'copyPassword' });
        });
      }
    });

    // Save password
    document.getElementById('savePassword')?.addEventListener('click', () => {
      const pw = document.getElementById('passwordInput')?.value || '';
      sendMsg({ type: 'savePassword', password: pw });
    });

    // Save Telegram token
    document.getElementById('saveToken')?.addEventListener('click', () => {
      const token = document.getElementById('botTokenInput')?.value;
      if (token) sendMsg({ type: 'saveTelegramToken', token });
    });

    // Copy settings filter
    document.getElementById('copySettingsFilter')?.addEventListener('click', () => {
      sendMsg({ type: 'copySettingsFilter' });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
