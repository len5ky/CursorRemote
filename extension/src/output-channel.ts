import * as vscode from 'vscode';

const CHANNEL_NAME = 'CursorRemote';

/**
 * Wraps either a LogOutputChannel or a plain OutputChannel behind
 * a uniform interface so the rest of the extension can use
 * `.info()`, `.warn()`, `.error()`, `.show()`, `.dispose()`.
 */
export interface UnifiedOutputChannel extends vscode.Disposable {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  show(preserveFocus?: boolean): void;
  appendLine(msg: string): void;
}

export function createOutputChannel(): UnifiedOutputChannel {
  try {
    const ch = vscode.window.createOutputChannel(CHANNEL_NAME, { log: true });
    return ch as UnifiedOutputChannel;
  } catch {
    const ch = vscode.window.createOutputChannel(CHANNEL_NAME);
    return {
      info:  (m) => ch.appendLine(m),
      warn:  (m) => ch.appendLine(`[WARN] ${m}`),
      error: (m) => ch.appendLine(`[ERROR] ${m}`),
      show:  (preserveFocus) => ch.show(preserveFocus),
      appendLine: (m) => ch.appendLine(m),
      dispose: () => ch.dispose(),
    };
  }
}

interface JsonLogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export function appendLogLine(channel: UnifiedOutputChannel, raw: string): void {
  try {
    const parsed: JsonLogLine = JSON.parse(raw);
    switch (parsed.level) {
      case 'error': channel.error(parsed.msg); break;
      case 'warn':  channel.warn(parsed.msg);  break;
      default:      channel.info(parsed.msg);   break;
    }
  } catch {
    channel.info(raw);
  }
}
