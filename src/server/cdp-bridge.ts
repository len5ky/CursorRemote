import { EventEmitter } from 'events';
import { CdpClient } from './cdp-client.js';
import type { ServerConfig, CursorWindow } from './types.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Extract the workspace folder name from a connected Cursor renderer page.
 * Uses vscode.context.configuration().workspace.uri which is available in every
 * Cursor/VS Code Electron renderer — stable across platforms and not affected
 * by the volatile document.title / CDP target title.
 */
export async function extractWorkspaceName(client: CdpClient, includeQualifier = true): Promise<string | null> {
  try {
    const raw = await client.evaluate(`
      (() => {
        try {
          const ws = vscode.context.configuration().workspace;
          if (!ws || !ws.uri) return null;
          return JSON.stringify({ path: ws.uri.path, authority: ws.uri.authority || '' });
        } catch { return null; }
      })()
    `, 3000);
    if (!raw || typeof raw !== 'string') return null;
    const { path, authority } = JSON.parse(raw) as { path: string; authority: string };
    if (!path) return null;
    const basename = path.split('/').filter(Boolean).pop() || path;
    if (!includeQualifier) return basename;
    const qualifier = authorityToQualifier(authority);
    return qualifier ? `${basename} ${qualifier}` : basename;
  } catch {
    return null;
  }
}

/** Fallback title parsing for non-connected windows (before Runtime.evaluate is available). */
export function parseCdpTitle(raw: string): string {
  let title = raw;
  const cursorSuffix = ' - Cursor';
  if (title.endsWith(cursorSuffix)) {
    title = title.slice(0, -cursorSuffix.length);
  }
  const dashParts = title.split(' - ');
  if (dashParts.length >= 3) {
    title = dashParts[dashParts.length - 2];
  } else if (dashParts.length === 2) {
    title = dashParts[dashParts.length - 1];
  }
  return title.trim();
}

function authorityToQualifier(authority: string): string {
  if (!authority) return '';
  if (authority.startsWith('wsl+')) {
    return `[WSL: ${authority.slice(4)}]`;
  }
  if (authority.startsWith('ssh-remote+')) {
    const hex = authority.slice('ssh-remote+'.length);
    try {
      const decoded = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')) as { hostName?: string };
      return decoded.hostName ? `[SSH: ${decoded.hostName}]` : `[SSH]`;
    } catch {
      return `[SSH: ${hex.substring(0, 16)}]`;
    }
  }
  return `[${authority}]`;
}

export class CDPBridge extends EventEmitter {
  private config: ServerConfig;
  private client: CdpClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private intentionalDisconnect = false;
  private _activeTargetId = '';
  private _windows: CursorWindow[] = [];
  private _activeWorkspaceName: string | null = null;

  constructor(config: ServerConfig) {
    super();
    this.config = config;
  }

  get activeTargetId(): string {
    return this._activeTargetId;
  }

  get windows(): CursorWindow[] {
    return this._windows;
  }

  async connect(targetId?: string): Promise<void> {
    try {
      const targets = await this.fetchTargets(true);
      this._windows = this.targetsToWindows(targets);

      let target: CDPTarget | undefined;
      if (targetId) {
        target = targets.find(t => t.id === targetId);
      }
      if (!target) {
        target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
      }
      if (!target) {
        target = targets.find(t => t.type === 'page');
      }
      if (!target?.webSocketDebuggerUrl) {
        throw new Error('No suitable CDP target found');
      }

      console.log(`[cdp-bridge] Connecting to target: "${target.title}" (${target.url})`);

      this.client = new CdpClient();
      await this.client.connect(target.webSocketDebuggerUrl);
      this._activeTargetId = target.id;

      this._activeWorkspaceName = await extractWorkspaceName(this.client, this.config.windowTitleQualifier);
      if (this._activeWorkspaceName) {
        const win = this._windows.find(w => w.id === target!.id);
        if (win) win.title = this._activeWorkspaceName;
        console.log(`[cdp-bridge] Workspace name: "${this._activeWorkspaceName}"`);
      }

      this.client.on('disconnected', () => {
        if (!this.intentionalDisconnect) {
          console.warn('[cdp-bridge] CDP connection lost unexpectedly');
          this.handleDisconnect();
        }
      });

      this.reconnectDelay = 1000;
      console.log('[cdp-bridge] Connected successfully');
      this.emit('connected');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cdp-bridge] Connection failed: ${message}`);
      this.emit('error', err);
      this.scheduleReconnect();
    }
  }

  async switchWindow(targetId: string): Promise<void> {
    if (targetId === this._activeTargetId) return;

    this.intentionalDisconnect = true;
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this._activeTargetId = '';
    this.emit('disconnected');

    this.intentionalDisconnect = false;
    await this.connect(targetId);
  }

  async refreshWindows(): Promise<CursorWindow[]> {
    try {
      const targets = await this.fetchTargets();
      this._windows = this.targetsToWindows(targets);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[cdp-bridge] Failed to refresh windows: ${message}`);
    }
    return this._windows;
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }

  getClient(): CdpClient | null {
    return this.client;
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isConnected();
  }

  private async fetchTargets(verbose = false): Promise<CDPTarget[]> {
    const url = `${this.config.cdpUrl}/json`;
    if (verbose) console.log(`[cdp-bridge] Discovering targets at ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`CDP target discovery failed: HTTP ${response.status}`);
    }

    const targets: CDPTarget[] = await response.json() as CDPTarget[];
    if (verbose) {
      console.log(`[cdp-bridge] Found ${targets.length} target(s):`);
      for (const t of targets) {
        console.log(`  [${t.type}] "${t.title}" — ${t.url}`);
      }
    }
    return targets;
  }

  private targetsToWindows(targets: CDPTarget[]): CursorWindow[] {
    return targets
      .filter(t => t.type === 'page' && t.url.includes('workbench'))
      .map(t => {
        // For the connected window, prefer the workspace name extracted via Runtime.evaluate
        if (t.id === this._activeTargetId && this._activeWorkspaceName) {
          return { id: t.id, title: this._activeWorkspaceName, url: t.url, wsUrl: t.webSocketDebuggerUrl };
        }
        // Fallback: parse the CDP target title (used for non-connected windows
        // until they get polled with their own temporary CDP connection)
        return { id: t.id, title: parseCdpTitle(t.title), url: t.url, wsUrl: t.webSocketDebuggerUrl };
      });
  }

  private handleDisconnect(): void {
    this.client = null;
    this._activeTargetId = '';
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    if (this.reconnectTimer) return;

    console.log(`[cdp-bridge] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      await this.connect();
    }, this.reconnectDelay);
  }
}
