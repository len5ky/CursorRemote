import * as vscode from 'vscode';
import { ChildProcess, spawn, exec } from 'child_process';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { EventEmitter } from 'events';
import { buildEnvFromConfig } from './config-bridge.js';
import { appendLogLine, type UnifiedOutputChannel } from './output-channel.js';
import { updateStatusBar, type HealthData, type ServerState } from './status-bar.js';

const HEALTH_POLL_INTERVAL_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 3000;
const MAX_TAKEOVER_JITTER_MS = 3000;

export class ServerManager extends EventEmitter {
  private context: vscode.ExtensionContext;
  private outputChannel: UnifiedOutputChannel;
  private statusBarItem: vscode.StatusBarItem;
  private child: ChildProcess | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private lastHealth: HealthData | null = null;
  private _serverState: ServerState = 'stopped';
  private _isOwner = false;
  private _takingOver = false;
  private getLicenseKey: () => Promise<string | undefined>;
  private readonly windowName: string;

  get serverState(): ServerState {
    return this._serverState;
  }

  get health(): HealthData | null {
    return this.lastHealth;
  }

  get isOwner(): boolean {
    return this._isOwner;
  }

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: UnifiedOutputChannel,
    statusBarItem: vscode.StatusBarItem,
    getLicenseKey: () => Promise<string | undefined>
  ) {
    super();
    this.context = context;
    this.outputChannel = outputChannel;
    this.statusBarItem = statusBarItem;
    this.getLicenseKey = getLicenseKey;
    this.windowName = vscode.workspace.name
      ?? vscode.workspace.workspaceFolders?.[0]?.name
      ?? 'unknown';
  }

  private getHealthUrl(): { port: string; host: string; url: string } {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    const port = String(config.get<number>('serverPort', 3000));
    const host = config.get<string>('serverHost', '127.0.0.1');
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    return { port, host, url: `http://${displayHost}:${port}/health` };
  }

  private async probeExistingServer(): Promise<boolean> {
    const { url } = this.getHealthUrl();
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const data = await resp.json() as HealthData;
        this.lastHealth = data;
        return true;
      }
    } catch { /* not running */ }
    return false;
  }

  async start(): Promise<void> {
    if (this.child) {
      vscode.window.showInformationMessage('Server is already running (owned by this window).');
      return;
    }

    const { port, host } = this.getHealthUrl();
    const alreadyRunning = await this.probeExistingServer();
    if (alreadyRunning) {
      this.outputChannel.info(`[${this.windowName}] Server already running — attaching as observer.`);
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
      this.emit('started');
      return;
    }

    const licenseKey = await this.getLicenseKey();
    const env = buildEnvFromConfig(this.context, licenseKey);

    const dataDir = env.DATA_DIR;
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const tempDir = join(this.context.extensionPath, 'temp');
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }

    const serverScript = join(this.context.extensionPath, 'dist', 'server', 'bundle.mjs');

    this.outputChannel.info(`[${this.windowName}] Starting server: ${serverScript}`);

    this.child = spawn(process.execPath, ['--no-deprecation', '--disable-warning=DEP0040', serverScript], {
      cwd: this.context.extensionPath,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._isOwner = true;

    this.child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        appendLogLine(this.outputChannel, line);
        this.detectStatusFromLog(line);
      }
    });

    let stderrBuffer = '';
    this.child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;
      const lines = text.split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (line.includes('DEP0040') || (line.includes('punycode') && line.includes('deprecated'))) continue;
        appendLogLine(this.outputChannel, line);
      }
    });

    this.child.on('exit', (code, signal) => {
      this.outputChannel.info(`[${this.windowName}] Server exited (code=${code}, signal=${signal})`);
      this.child = null;
      this._isOwner = false;
      this.stopHealthPolling();

      const portTaken = stderrBuffer.includes('EADDRINUSE');
      if (portTaken) {
        this.outputChannel.info(`[${this.windowName}] Port already in use — falling back to observer.`);
        this.fallbackToObserver();
        return;
      }

      if (code !== 0 && code !== null) {
        this.outputChannel.show(true);
        this.setState('error');
      } else {
        this.setState('stopped');
      }
      this.emit('stopped');
    });

    this.child.on('error', (err) => {
      this.outputChannel.error(`[${this.windowName}] Server spawn error: ${err.message}`);
      this.outputChannel.show(true);
      this.child = null;
      this._isOwner = false;
      this.stopHealthPolling();
      this.setState('error');
    });

    this.outputChannel.show(true);
    this.setState('disconnected');
    this.startHealthPolling(env.SERVER_PORT, env.SERVER_HOST);
    this.emit('started');
  }

  async stop(): Promise<void> {
    this.stopHealthPolling();

    if (!this.child) {
      if (this._serverState !== 'stopped') {
        this.outputChannel.info(`[${this.windowName}] Detaching from server (owned by another window).`);
        this.setState('stopped');
      }
      return;
    }

    this.outputChannel.info(`[${this.windowName}] Stopping server...`);

    const child = this.child;
    this.child = null;
    this._isOwner = false;

    return new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);

      child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });

      child.kill('SIGTERM');
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async openWebClient(): Promise<void> {
    const config = vscode.workspace.getConfiguration('cursorRemote');
    const port = config.get<number>('serverPort', 3000);
    const host = config.get<string>('serverHost', '127.0.0.1');
    const displayHost = host === '0.0.0.0' ? 'localhost' : host;
    const url = `http://${displayHost}:${port}`;
    this.outputChannel.info(`[${this.windowName}] Opening web client: ${url}`);

    if (process.platform === 'win32') {
      exec(`start "" "${url}"`);
    } else if (process.platform === 'darwin') {
      exec(`open "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  }

  private setState(state: ServerState): void {
    this._serverState = state;
    updateStatusBar(this.statusBarItem, state, this.lastHealth ?? undefined);
    this.emit('stateChanged', state);
  }

  private detectStatusFromLog(raw: string): void {
    try {
      const parsed = JSON.parse(raw);
      const msg: string = parsed.msg ?? '';
      if (msg.includes('[cdp-bridge] Connected to')) {
        this.setState('running');
      } else if (msg.includes('[cdp-bridge] Disconnected') || msg.includes('[cdp-bridge] Connection lost')) {
        this.setState('disconnected');
      } else if (msg.includes('[CRASH]')) {
        this.setState('error');
      }
    } catch {
      // non-JSON line, ignore
    }
  }

  private async fallbackToObserver(): Promise<void> {
    const { port, host } = this.getHealthUrl();
    const alive = await this.probeExistingServer();
    if (alive) {
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
      this.emit('started');
    } else {
      this.setState('error');
    }
  }

  private async attemptTakeover(): Promise<void> {
    if (this._takingOver || this.child) return;
    this._takingOver = true;

    const jitter = Math.floor(Math.random() * MAX_TAKEOVER_JITTER_MS);
    this.outputChannel.info(`[${this.windowName}] Owner window closed — will attempt takeover in ${jitter}ms.`);

    await new Promise(r => setTimeout(r, jitter));

    const stillDown = !(await this.probeExistingServer());
    if (stillDown) {
      this.outputChannel.info(`[${this.windowName}] Server still down — taking over.`);
      this._takingOver = false;
      await this.start();
    } else {
      this.outputChannel.info(`[${this.windowName}] Another window took over — staying as observer.`);
      this._takingOver = false;
      const { port, host } = this.getHealthUrl();
      this._isOwner = false;
      this.setState(this.lastHealth?.connected ? 'running' : 'disconnected');
      this.startHealthPolling(port, host);
    }
  }

  private startHealthPolling(port: string, host: string): void {
    this.stopHealthPolling();
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    const url = `http://${displayHost}:${port}/health`;

    let failCount = 0;
    const poll = async () => {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          failCount = 0;
          const data = await resp.json() as HealthData;
          this.lastHealth = data;
          const state: ServerState = data.connected ? 'running' : 'disconnected';
          this.setState(state);
          this.emit('health', data);
        }
      } catch {
        failCount++;
        if (!this.child && failCount >= 3) {
          this.outputChannel.info(`[${this.windowName}] External server no longer reachable.`);
          this.stopHealthPolling();
          this.attemptTakeover().catch(() => this.setState('error'));
        }
      }
    };

    this.healthTimer = setInterval(poll, HEALTH_POLL_INTERVAL_MS);
    setTimeout(poll, 2000);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  dispose(): void {
    this.stopHealthPolling();
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}
