import { readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { InlineKeyboard } from 'grammy';
import { parse as parseHtml, HTMLElement as ParsedEl, TextNode } from 'node-html-parser';
import type {
  ChatElement,
  CodeBlockItem,
  HumanMessage,
  AssistantMessage,
  ToolCallElement,
  ThoughtBlock,
  PlanBlock,
  PlanTodo,
  TodoListBlock,
  RunCommand,
  LoadingIndicator,
  Approval,
  ComposerQueueState,
} from '../../types.js';

const TG_MSG_LIMIT = 4096;

export interface FormattedMessage {
  html: string;
  keyboard?: InlineKeyboard;
}

export function formatElement(
  element: ChatElement,
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  switch (element.type) {
    case 'human': return formatHuman(element);
    case 'assistant': return formatAssistant(element);
    case 'tool': return formatTool(element, hashCallback);
    case 'thought': return formatThought(element);
    case 'plan': return formatPlan(element, hashCallback);
    case 'todo_list': return formatTodoList(element);
    case 'run_command': return formatRunCommand(element, hashCallback);
    case 'loading': return formatLoading(element);
  }
}

export function formatActivity(text: string): string {
  return `<i>● ${escapeHtml(text)}…</i>`;
}

/** Forum message body for composer toolbar queue; empty string if no queue. */
export function formatComposerQueue(queue: ComposerQueueState | undefined): string {
  if (!queue?.items?.length) return '';
  const hdr = queue.queueLabel?.trim() || 'Queued';
  const lines: string[] = [`<b>${escapeHtml(hdr)}</b>`, ''];
  for (const it of queue.items) {
    const t = it.text.trim() || '(empty)';
    lines.push(`▸ ${escapeHtml(t.length > 220 ? `${t.slice(0, 219)}…` : t)}`);
  }
  return lines.join('\n');
}

function formatHuman(msg: HumanMessage): FormattedMessage {
  const parts: string[] = [];
  if (msg.quoted?.text) {
    parts.push(
      `<blockquote expandable="false">${escapeHtml(msg.quoted.text)}</blockquote>`
    );
  }
  parts.push(`<b>You:</b> ${escapeHtml(msg.text)}`);
  let html = parts.join('\n');
  if (msg.mentions.length > 0) {
    const mentionStr = msg.mentions.map(m => `@${escapeHtml(m.name)}`).join(' ');
    html += `\n<i>${mentionStr}</i>`;
  }
  return { html };
}

function formatAssistant(msg: AssistantMessage): FormattedMessage {
  const html = msg.html ? cursorHtmlToTelegram(msg.html, msg.codeBlocks) : escapeHtml(msg.text);
  return { html };
}

function toolDiffStatsSuffix(msg: Pick<ToolCallElement, 'additions' | 'deletions'>): string {
  const stats: string[] = [];
  if (msg.additions !== undefined) stats.push(`<b>+${msg.additions}</b>`);
  if (msg.deletions !== undefined) stats.push(`<b>-${msg.deletions}</b>`);
  return stats.length > 0 ? `  ${stats.join(' ')}` : '';
}

function formatTool(
  msg: ToolCallElement,
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  const icon = msg.status === 'completed' ? '✓' : '●';

  if (msg.filename) {
    const statsStr = toolDiffStatsSuffix(msg);
    const action = msg.action ? `<b>${escapeHtml(msg.action)}</b> ` : '';
    const detailSuffix = msg.details && msg.details !== msg.filename
      ? msg.details.replace(msg.filename, '').trim() : '';
    const rangeInfo = detailSuffix ? ` ${escapeHtml(detailSuffix)}` : '';
    let html = `${icon} ${action}<code>${escapeHtml(msg.filename)}</code>${rangeInfo}${statsStr}`;

    if (msg.blocked) {
      html += `\n⚠️ ${escapeHtml(msg.blocked)}`;
    }

    const keyboard = new InlineKeyboard();
    const diffHash = hashCallback(msg.toolCallId);
    keyboard.text('📄 View Diff', `dif:${msg.toolCallId.substring(0, 8)}:${diffHash}`);

    if (msg.actions && msg.actions.length > 0) {
      for (const act of msg.actions) {
        const hash = hashCallback(act.selectorPath);
        const prefix = act.type === 'run' ? 'run' : act.type === 'skip' ? 'skp' : 'alw';
        const label = act.type === 'run' ? '✅ Accept'
          : act.type === 'skip' ? '⏭ Skip'
          : `🔓 ${act.label}`;
        keyboard.text(label, `${prefix}:${msg.id.substring(0, 8)}:${hash}`);
      }
    }

    return { html, keyboard };
  }

  if (msg.summaryText) {
    const text = msg.summaryText.trim();
    const firstLine = text.split('\n')[0].substring(0, 80);
    const hasCode = text.includes('{') || text.includes('(') || text.length > 100;

    if (hasCode) {
      const html = `${icon} <b>${escapeHtml(msg.action || 'Tool')}</b>\n<pre>${escapeHtml(text.substring(0, 500))}</pre>`;
      const hash = hashCallback(msg.toolCallId);
      const keyboard = new InlineKeyboard();
      keyboard.text('📄 View Full', `dif:${msg.toolCallId.substring(0, 8)}:${hash}`);
      return { html, keyboard };
    }
    return { html: `${icon} <b>${escapeHtml(msg.action || '')}</b> ${escapeHtml(firstLine)}${toolDiffStatsSuffix(msg)}` };
  }

  let line = `${icon} <b>${escapeHtml(msg.action || 'Tool')}</b>`;
  if (msg.details) line += ` <code>${escapeHtml(msg.details)}</code>`;
  line += toolDiffStatsSuffix(msg);
  return { html: line };
}

/** True while the thought header still looks in-flight (not a completed step summary). */
export function thoughtAppearsInProgress(msg: ThoughtBlock): boolean {
  if (msg.duration) return false;
  if (msg.thoughtKind === 'step_summary' && (msg.detail || '').trim().length > 0) return false;
  const d = msg.detail?.trim() ?? '';
  if (d && !/^for\s/i.test(d)) return false;
  return true;
}

function activityLabelMatchesThoughtAction(activity: string, thoughtAction: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/…+/gu, '')
      .replace(/\.+$/u, '')
      .replace(/\s+/g, ' ');
  const a = norm(activity);
  const b = norm(thoughtAction);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.startsWith(a) || a.startsWith(b)) return true;
  if (a.length <= 24 && b.includes(a)) return true;
  if (b.length <= 24 && a.includes(b)) return true;
  return false;
}

/**
 * When agentActivityText duplicates an in-flight 📎 step-summary line, skip the ephemeral
 * ● activity message — otherwise Telegram shows two near-identical lines (and two spoilers).
 */
export function activityRedundantWithInProgressStepSummary(
  activityText: string | undefined,
  elements: ChatElement[]
): boolean {
  if (!activityText?.trim()) return false;
  const recent = elements.slice(-24);
  for (let i = recent.length - 1; i >= 0; i--) {
    const el = recent[i];
    if (el.type !== 'thought') continue;
    if (el.thoughtKind !== 'step_summary' || !el.action) continue;
    if (!thoughtAppearsInProgress(el)) continue;
    if (activityLabelMatchesThoughtAction(activityText, el.action)) return true;
  }
  return false;
}

function formatThought(msg: ThoughtBlock): FormattedMessage {
  const spoiler = thoughtAppearsInProgress(msg) ? ' <tg-spoiler>*spoiler*</tg-spoiler>' : '';
  if (msg.thoughtKind === 'step_summary' && msg.action) {
    const detail = msg.detail ? ` — <code>${escapeHtml(msg.detail)}</code>` : '';
    return { html: `<b>📎 ${escapeHtml(msg.action)}</b>${detail}${spoiler}` };
  }
  if (msg.thoughtKind === 'thinking_step' && msg.action) {
    const timing = msg.duration ? ` · ${escapeHtml(msg.duration)}` : '';
    const detail = msg.detail && !msg.duration ? ` ${escapeHtml(msg.detail)}` : '';
    return { html: `<i>◆ ${escapeHtml(msg.action)}${detail}${timing}</i>${spoiler}` };
  }
  if (msg.action) {
    const detail = msg.detail ? ` ${escapeHtml(msg.detail)}` : '';
    return { html: `<i>💭 ${escapeHtml(msg.action)}${detail}</i>${spoiler}` };
  }
  return { html: `<i>💭 Thought for ${escapeHtml(msg.duration)}</i>` };
}

function formatLoading(msg: LoadingIndicator): FormattedMessage {
  const text = msg.text ? `● ${escapeHtml(msg.text)}…` : '💭 Thinking…';
  return { html: `<i>${text}</i>` };
}

function formatPlan(
  msg: PlanBlock,
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  const lines: string[] = [];
  lines.push(`<b>📋 ${escapeHtml(msg.title)}</b>`);
  if (msg.label) lines.push(`<i>${escapeHtml(msg.label)}</i>`);
  if (msg.description) lines.push('');
  if (msg.description) lines.push(escapeHtml(msg.description));

  if (msg.todos && msg.todos.length > 0) {
    lines.push('');
    lines.push(`<b>To-dos (${msg.todosCompleted}/${msg.todosTotal}):</b>`);
    for (const todo of msg.todos) {
      const icon = todo.status === 'completed' ? '✅'
        : todo.status === 'in_progress' ? '🔵'
        : '⚪';
      lines.push(`${icon} ${escapeHtml(todo.text)}`);
    }
  } else if (msg.todosTotal > 0) {
    lines.push(`\nProgress: ${msg.todosCompleted}/${msg.todosTotal}`);
  }

  if (msg.model) lines.push(`\nModel: ${escapeHtml(msg.model)}`);

  let keyboard: InlineKeyboard | undefined;
  if (msg.actions && msg.actions.length > 0) {
    keyboard = new InlineKeyboard();
    for (const action of msg.actions) {
      const hash = hashCallback(action.selectorPath);
      const label = action.type === 'build' ? '▶ Build' : '📄 View Plan';
      const data = `${action.type === 'build' ? 'bld' : 'vpl'}:${msg.id.substring(0, 8)}:${hash}`;
      keyboard.text(label, data);
    }
  }

  return { html: lines.join('\n'), keyboard };
}

function formatTodoList(msg: TodoListBlock): FormattedMessage {
  const lines: string[] = [];
  lines.push(`<b>📝 ${escapeHtml(msg.title)} (${msg.todosCompleted}/${msg.todosTotal}):</b>`);
  for (const todo of msg.todos) {
    const icon = todo.status === 'completed' ? '✅'
      : todo.status === 'in_progress' ? '🔵'
      : '⚪';
    lines.push(`${icon} ${escapeHtml(todo.text)}`);
  }
  return { html: lines.join('\n') };
}

function formatRunCommand(
  msg: RunCommand,
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  const lines: string[] = [];
  let header = `<b>🖥 ${escapeHtml(msg.description)}</b>`;
  if (msg.candidates) header += `  <code>${escapeHtml(msg.candidates)}</code>`;
  lines.push(header);
  lines.push(`<pre><code class="language-bash">$ ${escapeHtml(msg.command)}</code></pre>`);

  let keyboard: InlineKeyboard | undefined;
  if (msg.actions.length > 0) {
    keyboard = new InlineKeyboard();
    for (const action of msg.actions) {
      const hash = hashCallback(action.selectorPath);
      const prefix = action.type === 'run' ? 'run' : action.type === 'skip' ? 'skp' : 'alw';
      const label = action.type === 'run' ? '▶ Run'
        : action.type === 'skip' ? '⏭ Skip'
        : `🔓 ${action.label}`;
      keyboard.text(label, `${prefix}:${msg.id.substring(0, 8)}:${hash}`);
    }
  }

  return { html: lines.join('\n'), keyboard };
}

interface PlanFile {
  todos: PlanTodo[];
  body: string;
}

function readPlanFile(label: string): PlanFile | null {
  const planPath = resolve(homedir(), '.cursor', 'plans', label);
  try {
    const raw = readFileSync(planPath, 'utf-8');
    return parsePlanMd(raw);
  } catch {
    return null;
  }
}

function parsePlanMd(raw: string): PlanFile {
  const todos: PlanTodo[] = [];
  let body = raw;

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    const fm = fmMatch[1];
    const todoRe = /- id:\s*\S+\n\s+content:\s*["']?(.*?)["']?\s*\n\s+status:\s*(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = todoRe.exec(fm)) !== null) {
      const status = m[2] as PlanTodo['status'];
      todos.push({ text: m[1], status });
    }
  }

  return { todos, body: body.trim() };
}

function markdownToTelegramHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];

  for (const line of lines) {
    if (inCodeBlock) {
      if (line.startsWith('```')) {
        const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
        out.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeLines = [];
        codeLang = '';
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (line.startsWith('```')) {
      inCodeBlock = true;
      codeLang = line.slice(3).trim();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      out.push('');
      out.push(`<b>${inlineMarkdown(headingMatch[2])}</b>`);
      continue;
    }

    if (line.match(/^\s*[-*]\s/)) {
      const content = line.replace(/^\s*[-*]\s+/, '');
      out.push(`• ${inlineMarkdown(content)}`);
      continue;
    }

    const olMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (olMatch) {
      out.push(`${olMatch[1]}. ${inlineMarkdown(olMatch[2])}`);
      continue;
    }

    if (line.startsWith('|') && line.endsWith('|')) {
      if (line.match(/^\|[\s:-]+\|$/)) continue;
      const cells = line.split('|').slice(1, -1).map(c => inlineMarkdown(c.trim()));
      out.push(cells.join(' | '));
      continue;
    }

    if (line.trim() === '') {
      out.push('');
      continue;
    }

    out.push(inlineMarkdown(line));
  }

  if (inCodeBlock && codeLines.length > 0) {
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function inlineMarkdown(text: string): string {
  let result = escapeHtml(text);
  // bold+italic ***text*** or ___text___
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  // bold **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');
  // italic *text* or _text_ (not inside words for underscore)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');
  // inline code `text`
  result = result.replace(/`([^`]+?)`/g, '<code>$1</code>');
  // links [text](url) — strip the link syntax from [path](path) plan references
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    if (href.startsWith('http')) return `<a href="${href}">${label}</a>`;
    return `<code>${label}</code>`;
  });
  return result;
}

export function formatPlanFull(msg: PlanBlock): string {
  const planFile = msg.label ? readPlanFile(msg.label) : null;

  if (planFile) {
    const parts: string[] = [];

    if (planFile.todos.length > 0) {
      const completed = planFile.todos.filter(t => t.status === 'completed').length;
      parts.push(`<b>To-dos (${completed}/${planFile.todos.length}):</b>`);
      for (const todo of planFile.todos) {
        const icon = todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '🔵' : '⚪';
        parts.push(`${icon} ${escapeHtml(todo.text)}`);
      }
      parts.push('');
    }

    parts.push(markdownToTelegramHtml(planFile.body));
    return parts.join('\n');
  }

  // Fallback: use data from DOM extraction
  const lines: string[] = [];
  lines.push(`<b>📋 ${escapeHtml(msg.title)}</b>`);
  if (msg.label) lines.push(`<i>${escapeHtml(msg.label)}</i>`);
  if (msg.description) lines.push('', escapeHtml(msg.description));

  if (msg.todos && msg.todos.length > 0) {
    lines.push('', `<b>To-dos (${msg.todosCompleted}/${msg.todosTotal}):</b>`);
    for (const todo of msg.todos) {
      const icon = todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '🔵' : '⚪';
      lines.push(`${icon} ${escapeHtml(todo.text)}`);
    }
    if (msg.todos.length < msg.todosTotal) {
      lines.push(`<i>… ${msg.todosTotal - msg.todos.length} more (expand in Cursor)</i>`);
    }
  }
  return lines.join('\n');
}

export function formatApprovals(
  approvals: Approval[],
  hashCallback: (selectorPath: string) => string
): FormattedMessage {
  if (approvals.length === 0) return { html: '' };

  const approval = approvals[0];
  const html = `⚠️ <b>Approval needed:</b> ${escapeHtml(approval.description)}`;

  const keyboard = new InlineKeyboard();
  for (const action of approval.actions) {
    const hash = hashCallback(action.selectorPath);
    const prefix = action.type === 'approve' ? 'apr'
      : action.type === 'reject' ? 'rej'
      : 'all';
    const label = action.type === 'approve' ? `✅ ${action.label}`
      : action.type === 'reject' ? `❌ ${action.label}`
      : `✅ ${action.label}`;
    keyboard.text(label, `${prefix}:${approval.id.substring(0, 8)}:${hash}`);
  }

  return { html, keyboard };
}

export function splitMessage(html: string, limit: number = TG_MSG_LIMIT): string[] {
  if (html.length <= limit) return [html];

  const parts: string[] = [];
  let remaining = html;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n\n', limit);
    if (splitAt < limit * 0.3) splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt < limit * 0.3) splitAt = limit;
    parts.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  if (remaining) parts.push(remaining);

  return parts;
}

/**
 * Merge multiple formatted HTML blocks into fewer messages for quota efficiency.
 * Uses Telegram's <blockquote> for visual separation between blocks.
 * Returns chunks that fit within the limit, splitting at block boundaries.
 */
export function mergeFormattedBlocks(
  blocks: string[],
  limit: number = TG_MSG_LIMIT
): string[] {
  if (blocks.length === 0) return [];
  if (blocks.length === 1 && blocks[0].length <= limit) return [blocks[0]];

  const SEP = '\n\n';
  const wrapped = blocks.map(b => `<blockquote>${b}</blockquote>`);

  const chunks: string[] = [];
  let current = '';

  for (const block of wrapped) {
    const candidate = current ? current + SEP + block : block;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      if (block.length <= limit) {
        current = block;
      } else {
        // Single block exceeds limit: split it (strip blockquote, use splitMessage)
        const inner = block.replace(/^<blockquote>|<\/blockquote>$/g, '');
        for (const part of splitMessage(inner, limit - 25)) {
          chunks.push(`<blockquote>${part}</blockquote>`);
        }
        current = '';
      }
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function codeBlockItemTelegramBody(cb: CodeBlockItem): string {
  if (cb.blockKind === 'diff' && cb.diffLines && cb.diffLines.length > 0) {
    return cb.diffLines
      .map(l => {
        const prefix =
          l.kind === 'add' ? '+ ' : l.kind === 'rem' ? '- ' : l.kind === 'meta' || l.kind === 'hunk' ? '  ' : '  ';
        return prefix + l.text;
      })
      .join('\n');
  }
  return cb.code || '';
}

function cursorHtmlToTelegram(html: string, codeBlocks?: CodeBlockItem[]): string {
  const root = parseHtml(html);
  let cbIdx = 0;

  function hasClass(el: ParsedEl, cls: string): boolean {
    return (el.getAttribute('class') || '').split(/\s+/).includes(cls);
  }

  function directChildrenByTag(el: ParsedEl, tagName: string): ParsedEl[] {
    const lower = tagName.toLowerCase();
    return el.childNodes.filter(
      (n): n is ParsedEl => n instanceof ParsedEl && (n.rawTagName || '').toLowerCase() === lower
    );
  }

  function walkChildren(parent: ParsedEl): string {
    let result = '';
    for (const node of parent.childNodes) {
      if (node instanceof TextNode) {
        const text = node.textContent;
        if (!text.trim()) {
          if (result && !result.endsWith(' ') && !result.endsWith('\n')) result += ' ';
          continue;
        }
        result += escapeHtml(text);
      } else if (node instanceof ParsedEl) {
        result += walkElement(node);
      }
    }
    return result;
  }

  function walkElement(el: ParsedEl): string {
    const tag = (el.rawTagName || '').toLowerCase();

    // Skip non-content elements
    if (tag === 'button' || tag === 'svg' || tag === 'style' || tag === 'script') return '';
    if (tag === 'div' && hasClass(el, 'ui-scroll-area__scrollbar')) return '';
    if (tag === 'div' && hasClass(el, 'ui-code-block-copy-overlay')) return '';

    // Cursor composer / Shiki code block (markdown may still embed these)
    if (
      tag === 'div' &&
      (hasClass(el, 'composer-message-codeblock') || hasClass(el, 'composer-code-block-container'))
    ) {
      if (codeBlocks && cbIdx < codeBlocks.length) {
        const cb = codeBlocks[cbIdx++];
        const lang = cb.language ? ` class="language-${escapeHtml(cb.language)}"` : '';
        return `\n<pre><code${lang}>${escapeHtml(codeBlockItemTelegramBody(cb))}</code></pre>\n`;
      }
      return '\n' + extractShikiCode(el) + '\n';
    }

    // Headings → bold
    if (/^h[1-6]$/.test(tag)) return `\n\n<b>${walkChildren(el)}</b>\n\n`;

    // Paragraph
    if (tag === 'p') return `\n${walkChildren(el)}\n`;

    // Bold / strong
    if (tag === 'b' || tag === 'strong') return `<b>${walkChildren(el)}</b>`;

    // Italic / em (skip Cursor icon elements)
    if (tag === 'i' || tag === 'em') {
      if (hasClass(el, 'cursor-icon')) return '';
      return `<i>${walkChildren(el)}</i>`;
    }

    // Preserved inline formatting
    if (tag === 'u') return `<u>${walkChildren(el)}</u>`;
    if (tag === 's') return `<s>${walkChildren(el)}</s>`;

    // Span — class-based bold (Cursor uses span.font-semibold instead of <strong>)
    if (tag === 'span') {
      if (hasClass(el, 'font-semibold') || el.getAttribute('data-streamdown') === 'strong') {
        return `<b>${walkChildren(el)}</b>`;
      }
      return walkChildren(el);
    }

    // Inline code (don't double-wrap when inside <pre>)
    if (tag === 'code') {
      const parent = el.parentNode;
      if (parent instanceof ParsedEl && (parent.rawTagName || '').toLowerCase() === 'pre') {
        return escapeHtml(el.textContent);
      }
      return `<code>${escapeHtml(el.textContent)}</code>`;
    }

    // Preformatted block
    if (tag === 'pre') {
      const codeEl = el.querySelector('code');
      if (codeEl) {
        const cls = codeEl.getAttribute('class') || '';
        const m = cls.match(/language-(\w+)/);
        const langAttr = m ? ` class="language-${m[1]}"` : '';
        return `\n<pre><code${langAttr}>${escapeHtml(codeEl.textContent)}</code></pre>\n`;
      }
      return `\n<pre>${escapeHtml(el.textContent)}</pre>\n`;
    }

    // Link
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href) return `<a href="${escapeHtml(href)}">${walkChildren(el)}</a>`;
      return walkChildren(el);
    }

    // Blockquote
    if (tag === 'blockquote') return `\n<blockquote>${walkChildren(el)}</blockquote>\n`;

    // Unordered list
    if (tag === 'ul') {
      const items = directChildrenByTag(el, 'li');
      if (items.length > 0) {
        return '\n' + items.map(li => `• ${walkListItem(li)}`).join('\n') + '\n';
      }
      return walkChildren(el);
    }

    // Ordered list
    if (tag === 'ol') {
      const items = directChildrenByTag(el, 'li');
      if (items.length > 0) {
        return '\n' + items.map((li, i) => `${i + 1}. ${walkListItem(li)}`).join('\n') + '\n';
      }
      return walkChildren(el);
    }

    // Table
    if (tag === 'table') return '\n' + convertTable(el) + '\n';

    // Line breaks
    if (tag === 'br') return '\n';
    if (tag === 'hr') return '\n---\n';

    // Default: recurse into children
    return walkChildren(el);
  }

  function walkListItem(li: ParsedEl): string {
    let result = '';
    for (const child of li.childNodes) {
      if (child instanceof TextNode) {
        const text = child.textContent;
        if (!text.trim()) continue;
        result += escapeHtml(text);
      } else if (child instanceof ParsedEl) {
        if ((child.rawTagName || '').toLowerCase() === 'p') {
          result += walkChildren(child);
        } else {
          result += walkElement(child);
        }
      }
    }
    return result.trim();
  }

  function extractShikiCode(container: ParsedEl): string {
    const lineEls = container.querySelectorAll('.ui-default-code__line-content');
    if (lineEls.length > 0) {
      const code = lineEls.map(l => l.textContent).join('\n');
      return `<pre><code>${escapeHtml(code)}</code></pre>`;
    }
    const raw = container.textContent.trim();
    return raw ? `<pre><code>${escapeHtml(raw)}</code></pre>` : '';
  }

  function convertTable(table: ParsedEl): string {
    const lines: string[] = [];

    const thead = table.querySelector('thead');
    if (thead) {
      const ths = thead.querySelectorAll('th');
      if (ths.length > 0) {
        lines.push(ths.map(th => `<b>${walkChildren(th).trim()}</b>`).join(' | '));
      }
    }

    const tbody = table.querySelector('tbody');
    const trs = (tbody || table).querySelectorAll('tr');
    for (const tr of trs) {
      const tds = tr.querySelectorAll('td');
      if (tds.length === 0) continue;
      lines.push(tds.map(td => walkChildren(td).trim()).join(' | '));
    }

    return lines.join('\n');
  }

  let result = walkChildren(root);
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}
