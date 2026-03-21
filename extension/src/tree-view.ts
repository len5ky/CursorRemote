import * as vscode from 'vscode';
import type { ServerManager } from './server-manager.js';
import type { LicenseManager } from './license-manager.js';
import type { HealthData } from './status-bar.js';

type TreeItem = vscode.TreeItem;

export class StatusTreeView implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private serverManager: ServerManager;
  private licenseManager: LicenseManager;
  private licensed = false;

  constructor(serverManager: ServerManager, licenseManager: LicenseManager) {
    this.serverManager = serverManager;
    this.licenseManager = licenseManager;
    serverManager.on('health', () => this.refresh());
    serverManager.on('stateChanged', () => this.refresh());
    serverManager.on('stopped', () => this.refresh());

    licenseManager.checkLicense().then(valid => {
      this.licensed = valid;
      this.refresh();
    });
  }

  refresh(): void {
    this.licenseManager.checkLicense().then(valid => {
      this.licensed = valid;
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  getTreeItem(element: TreeItem): TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (element) return [];

    const items: TreeItem[] = [];

    if (!this.licensed) {
      const licenseItem = new vscode.TreeItem('License Key Required');
      licenseItem.iconPath = new vscode.ThemeIcon('key', new vscode.ThemeColor('errorForeground'));
      licenseItem.description = 'click to activate';
      licenseItem.command = { command: 'cursorRemote.enterLicenseKey', title: 'Enter License Key' };
      items.push(licenseItem);

      const buyItem = new vscode.TreeItem('Buy License');
      buyItem.iconPath = new vscode.ThemeIcon('credit-card');
      buyItem.command = { command: 'cursorRemote.buyLicense', title: 'Buy License' };
      items.push(buyItem);

      items.push(separator());

      const setupItem = new vscode.TreeItem('Open Setup Panel');
      setupItem.iconPath = new vscode.ThemeIcon('gear');
      setupItem.command = { command: 'cursorRemote.openSetup', title: 'Open Setup Panel' };
      items.push(setupItem);

      return items;
    }

    const state = this.serverManager.serverState;
    const health = this.serverManager.health;

    const serverItem = new vscode.TreeItem(
      `Server: ${state.charAt(0).toUpperCase() + state.slice(1)}`
    );
    serverItem.iconPath = new vscode.ThemeIcon(
      state === 'running' ? 'pass-filled' :
      state === 'disconnected' ? 'warning' :
      state === 'error' ? 'error' : 'circle-outline'
    );
    if (state === 'stopped') {
      serverItem.description = 'click to start';
      serverItem.command = { command: 'cursorRemote.start', title: 'Start Server' };
    } else {
      const parts: string[] = [];
      if (!this.serverManager.isOwner) parts.push('observer');
      if (health?.uptime) parts.push(`uptime ${formatUptime(health.uptime)}`);
      if (parts.length > 0) serverItem.description = parts.join(' · ');
    }
    items.push(serverItem);

    if (state === 'stopped') {
      const startItem = new vscode.TreeItem('Start Server');
      startItem.iconPath = new vscode.ThemeIcon('debug-start');
      startItem.command = { command: 'cursorRemote.start', title: 'Start Server' };
      items.push(startItem);
    } else {
      const stopItem = new vscode.TreeItem('Stop Server');
      stopItem.iconPath = new vscode.ThemeIcon('debug-stop');
      stopItem.command = { command: 'cursorRemote.stop', title: 'Stop Server' };
      items.push(stopItem);
    }

    if (health) {
      const cdpItem = new vscode.TreeItem(
        `CDP: ${health.connected ? 'Connected' : 'Disconnected'}`
      );
      cdpItem.iconPath = new vscode.ThemeIcon(health.connected ? 'plug' : 'debug-disconnect');
      const activeWindow = health.windows?.find(w => w.id === health.activeWindowId);
      if (activeWindow) {
        cdpItem.description = activeWindow.title;
      }
      items.push(cdpItem);

      const agentItem = new vscode.TreeItem(`Agent: ${health.agentStatus}`);
      agentItem.iconPath = new vscode.ThemeIcon('hubot');
      const descParts: string[] = [];
      if (health.mode) descParts.push(health.mode);
      if (health.model) descParts.push(health.model);
      if (descParts.length > 0) agentItem.description = descParts.join(' / ');
      items.push(agentItem);

      const clientItem = new vscode.TreeItem(`Clients: ${health.clients}`);
      clientItem.iconPath = new vscode.ThemeIcon('device-mobile');
      items.push(clientItem);

      if (health.pendingApprovalCount > 0) {
        const approvalItem = new vscode.TreeItem(
          `Pending Approvals: ${health.pendingApprovalCount}`
        );
        approvalItem.iconPath = new vscode.ThemeIcon('bell-dot');
        items.push(approvalItem);
      }

      if (health.windows?.length > 0) {
        const windowsItem = new vscode.TreeItem(
          `Windows: ${health.windows.length}`
        );
        windowsItem.iconPath = new vscode.ThemeIcon('multiple-windows');
        windowsItem.description = health.windows.map(w => w.title).join(', ');
        items.push(windowsItem);
      }
    }

    items.push(separator());

    const setupItem = new vscode.TreeItem('Open Setup Panel');
    setupItem.iconPath = new vscode.ThemeIcon('gear');
    setupItem.command = { command: 'cursorRemote.openSetup', title: 'Open Setup Panel' };
    items.push(setupItem);

    const openWebItem = new vscode.TreeItem('Open Web Client');
    openWebItem.iconPath = new vscode.ThemeIcon('link-external');
    openWebItem.command = { command: 'cursorRemote.openWebClient', title: 'Open Web Client' };
    items.push(openWebItem);

    const logsItem = new vscode.TreeItem('Show Logs');
    logsItem.iconPath = new vscode.ThemeIcon('output');
    logsItem.command = { command: 'cursorRemote.showLogs', title: 'Show Logs' };
    items.push(logsItem);

    return items;
  }
}

function separator(): vscode.TreeItem {
  const item = new vscode.TreeItem('');
  item.description = '─────────────';
  return item;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
