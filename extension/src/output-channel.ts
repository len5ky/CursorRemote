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
  reveal(headerLines: string[]): void;
  appendLine(msg: string): void;
}

export function createOutputChannel(): UnifiedOutputChannel {
  try {
    const ch = vscode.window.createOutputChannel(CHANNEL_NAME, { log: true });
    return createLogOutputChannelWrapper(ch);
  } catch {
    const ch = vscode.window.createOutputChannel(CHANNEL_NAME);
    return createPlainOutputChannelWrapper(ch);
  }
}

function createLogOutputChannelWrapper(ch: vscode.LogOutputChannel): UnifiedOutputChannel {
  let hasContent = false;

  const markContent = (): void => {
    hasContent = true;
  };

  return {
    info: (m) => {
      markContent();
      ch.info(m);
    },
    warn: (m) => {
      markContent();
      ch.warn(m);
    },
    error: (m) => {
      markContent();
      ch.error(m);
    },
    show: (preserveFocus) => ch.show(preserveFocus),
    reveal: (headerLines) => {
      if (!hasContent) {
        for (const line of headerLines) {
          ch.appendLine(line);
        }
        hasContent = headerLines.length > 0;
      }
      ch.show(true);
    },
    appendLine: (m) => {
      markContent();
      ch.appendLine(m);
    },
    dispose: () => ch.dispose(),
  };
}

function createPlainOutputChannelWrapper(ch: vscode.OutputChannel): UnifiedOutputChannel {
  let hasContent = false;

  const appendLine = (line: string): void => {
    hasContent = true;
    ch.appendLine(line);
  };

  return {
    info:  (m) => appendLine(m),
    warn:  (m) => appendLine(`[WARN] ${m}`),
    error: (m) => appendLine(`[ERROR] ${m}`),
    show:  (preserveFocus) => ch.show(preserveFocus),
    reveal: (headerLines) => {
      if (!hasContent) {
        for (const line of headerLines) {
          appendLine(line);
        }
      }
      ch.show(true);
    },
    appendLine,
    dispose: () => ch.dispose(),
  };
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
