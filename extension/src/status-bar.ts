import * as vscode from 'vscode';

export interface HealthData {
  ok: boolean;
  connected: boolean;
  agentStatus: string;
  clients: number;
  uptime: number;
  windows: { id: string; title: string }[];
  activeWindowId: string;
  mode: string | null;
  model: string | null;
  chatTabCount: number;
  pendingApprovalCount: number;
  generation: number;
}

export type ServerState = 'running' | 'disconnected' | 'stopped' | 'error';

export function createStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  item.command = 'workbench.action.quickOpen';
  updateStatusBar(item, 'stopped');
  item.show();
  context.subscriptions.push(item);
  return item;
}

export function updateStatusBar(
  item: vscode.StatusBarItem,
  state: ServerState,
  health?: HealthData
): void {
  switch (state) {
    case 'running':
      item.text = '$(radio-tower) Remote: Running';
      item.backgroundColor = undefined;
      item.color = '#3fa266';
      item.tooltip = buildTooltip(health);
      item.command = 'cursorRemote.status.focus';
      break;
    case 'disconnected':
      item.text = '$(radio-tower) Remote: Disconnected';
      item.backgroundColor = undefined;
      item.color = '#e5c07b';
      item.tooltip = 'Server running but CDP not connected — click to open panel';
      item.command = 'cursorRemote.status.focus';
      break;
    case 'stopped':
      item.text = '$(radio-tower) Remote: Stopped';
      item.backgroundColor = undefined;
      item.color = undefined;
      item.tooltip = 'Click to open panel';
      item.command = 'cursorRemote.status.focus';
      break;
    case 'error':
      item.text = '$(radio-tower) Remote: Error';
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      item.color = undefined;
      item.tooltip = 'Server crashed — click to open panel';
      item.command = 'cursorRemote.status.focus';
      break;
  }
}

function buildTooltip(health?: HealthData): string {
  if (!health) return 'Running';
  const lines = [
    `Port: ${health.clients !== undefined ? 'connected' : 'unknown'}`,
    `Clients: ${health.clients}`,
    `Agent: ${health.agentStatus}`,
  ];
  if (health.mode) lines.push(`Mode: ${health.mode}`);
  if (health.model) lines.push(`Model: ${health.model}`);
  const activeWindow = health.windows?.find(w => w.id === health.activeWindowId);
  if (activeWindow) lines.push(`Window: ${activeWindow.title}`);
  if (health.pendingApprovalCount > 0) lines.push(`Pending approvals: ${health.pendingApprovalCount}`);
  return lines.join('\n');
}
