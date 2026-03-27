import 'dotenv/config';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { Bot } from 'grammy';
import {
  formatElement,
  formatActivity,
  splitMessage,
} from '../src/server/transports/telegram/formatter.js';
import type { CursorState } from '../src/server/types.js';
import { deriveActivityFromSignals } from '../src/server/activity-derive.js';

interface RecordLineV1 {
  ts: number;
  state: CursorState | null;
}

interface RecordLineV2 {
  ts: number;
  state: CursorState | null;
  raw?: CursorState | null;
}

interface RecordLine {
  ts: number;
  state: CursorState | null;
}

function contentHash(html: string): string {
  return createHash('md5').update(html).digest('hex').substring(0, 12);
}

function elapsed(startMs: number): string {
  return `+${((Date.now() - startMs) / 1000).toFixed(1)}s`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').substring(0, 80);
}

async function main() {
  const args = process.argv.slice(2);
  const filePath = args.find(a => !a.startsWith('-'));
  const threadId = parseInt(args.find((_, i, a) => a[i - 1] === '--thread') ?? '0', 10);
  const speed = parseFloat(args.find((_, i, a) => a[i - 1] === '--speed') ?? '5');
  const chatIdArg = args.find((_, i, a) => a[i - 1] === '--chat');
  const dryRun = args.includes('--dry-run') || args.includes('--dry');

  if (!filePath || (!threadId && !dryRun)) {
    console.log('Usage: npm run replay -- <recording.jsonl> --thread <topic_id> [--chat <group_id>] [--speed N] [--dry-run]');
    console.log('\nRequires TELEGRAM_BOT_TOKEN in .env (unless --dry-run)');
    console.log('  --thread   Telegram forum topic message_thread_id');
    console.log('  --chat     Telegram group chat ID (default: from TELEGRAM_CHAT_ID env)');
    console.log('  --speed    Playback speed multiplier (default: 5)');
    console.log('  --dry-run  Log all API calls without sending them');
    process.exit(1);
  }

  const rawLines = readFileSync(filePath, 'utf-8').trim().split('\n');
  const parsed = rawLines.map(l => JSON.parse(l));
  const hasHeader = parsed[0]?.header != null;
  const dataLines = hasHeader ? parsed.slice(1) : parsed;
  const lines: RecordLine[] = dataLines.map((l: RecordLineV1 | RecordLineV2) => ({
    ts: l.ts,
    state: l.state,
  }));
  console.log(`[replay] Loaded ${lines.length} snapshots from ${filePath}${hasHeader ? ` (schema v${parsed[0].header.schemaVersion})` : ' (v1)'}`);
  console.log(`[replay] Speed: ${speed}x, thread: ${threadId}, chat: ${chatIdArg ?? 'env'}${dryRun ? ', DRY RUN' : ''}\n`);

  let nextMsgId = 90000;
  const startTime = Date.now();
  const hashCb = (_sp: string) => '00000000';

  // --- API layer (real or dry-run) ---
  let bot: Bot | undefined;
  let chatId = 0;

  if (!dryRun) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) { console.error('[replay] TELEGRAM_BOT_TOKEN not set'); process.exit(1); }
    chatId = parseInt(chatIdArg ?? process.env.TELEGRAM_CHAT_ID ?? '0', 10);
    if (!chatId) { console.error('[replay] Chat ID required'); process.exit(1); }
    bot = new Bot(botToken, { client: { fetch } });
    const me = await bot.api.getMe();
    console.log(`[replay] Bot: @${me.username}\n`);
  }

  const API_DELAY_MS = dryRun ? 0 : 3500;
  let lastApiCall = 0;

  async function throttle() {
    const now = Date.now();
    const wait = API_DELAY_MS - (now - lastApiCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastApiCall = Date.now();
  }

  async function apiSend(html: string): Promise<number> {
    if (dryRun) return nextMsgId++;
    await throttle();
    const parts = splitMessage(html);
    const msgIds: number[] = [];
    for (const part of parts) {
      try {
        const sent = await bot!.api.sendMessage(chatId, part, {
          message_thread_id: threadId,
          parse_mode: 'HTML',
        });
        msgIds.push(sent.message_id);
      } catch (err) {
        if (err instanceof Error && err.message.includes('429')) {
          const match = err.message.match(/retry after (\d+)/);
          const wait = match ? parseInt(match[1], 10) * 1000 + 1000 : 10000;
          console.warn(`[${elapsed(startTime)}] RATE LIMITED — waiting ${(wait / 1000).toFixed(0)}s...`);
          await new Promise(r => setTimeout(r, wait));
          const sent = await bot!.api.sendMessage(chatId, part, {
            message_thread_id: threadId,
            parse_mode: 'HTML',
          });
          msgIds.push(sent.message_id);
        } else {
          const plain = part.replace(/<[^>]*>/g, '');
          await throttle();
          const sent = await bot!.api.sendMessage(chatId, plain, { message_thread_id: threadId });
          msgIds.push(sent.message_id);
        }
      }
    }
    return msgIds[0];
  }

  async function apiEdit(msgId: number, html: string): Promise<void> {
    if (dryRun) return;
    await throttle();
    const parts = splitMessage(html);
    try {
      await bot!.api.editMessageText(chatId, msgId, parts[0], { parse_mode: 'HTML' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('429')) {
        const match = msg.match(/retry after (\d+)/);
        const wait = match ? parseInt(match[1], 10) * 1000 + 1000 : 10000;
        console.warn(`[${elapsed(startTime)}] RATE LIMITED — waiting ${(wait / 1000).toFixed(0)}s...`);
        await new Promise(r => setTimeout(r, wait));
        await bot!.api.editMessageText(chatId, msgId, parts[0], { parse_mode: 'HTML' });
      } else if (msg.includes('parse entities') || msg.includes('start tag')) {
        await bot!.api.editMessageText(chatId, msgId, parts[0].replace(/<[^>]*>/g, ''));
      } else if (!msg.includes('not modified')) {
        throw err;
      }
    }
  }

  async function apiDelete(msgId: number): Promise<void> {
    if (dryRun) return;
    await throttle();
    try { await bot!.api.deleteMessage(chatId, msgId); } catch { /* ok */ }
  }

  // --- State tracking ---
  let activityMsgId: number | undefined;
  let lastActivityText: string | undefined;
  const trackedMessages = new Map<string, { msgIds: number[]; hash: string }>();
  let prevState: CursorState | null = null;

  for (let i = 0; i < lines.length; i++) {
    const { ts, state } = lines[i];

    if (i > 0) {
      const gap = (ts - lines[i - 1].ts) / speed;
      if (gap > 0 && gap < 30000) {
        await new Promise(r => setTimeout(r, gap));
      }
    }

    if (!state) {
      if (prevState) {
        console.log(`[${elapsed(startTime)}] STATE null (disconnected)`);
      }
      prevState = null;
      continue;
    }

    // --- Activity indicator (re-derive from raw signals if available) ---
    const derived = state._rawSignals
      ? deriveActivityFromSignals(state._rawSignals, state.messages)
      : null;
    const activity = derived ? derived.activityText : state.agentActivityText;
    if (activity && !activityMsgId) {
      const html = formatActivity(activity);
      activityMsgId = await apiSend(html);
      lastActivityText = activity;
      console.log(`[${elapsed(startTime)}] SEND  activity "${activity}" -> msgId=${activityMsgId}`);
    } else if (activity && activityMsgId && activity !== lastActivityText) {
      const html = formatActivity(activity);
      try {
        await apiEdit(activityMsgId, html);
        lastActivityText = activity;
        console.log(`[${elapsed(startTime)}] EDIT  activity msgId=${activityMsgId} "${activity}"`);
      } catch { /* ok */ }
    } else if (!activity && activityMsgId) {
      await apiDelete(activityMsgId);
      console.log(`[${elapsed(startTime)}] DELETE activity msgId=${activityMsgId}`);
      activityMsgId = undefined;
      lastActivityText = undefined;
    }

    // --- Content messages ---
    for (const element of state.messages) {
      if (element.type === 'loading') continue;

      const formatted = formatElement(element, hashCb);
      if (!formatted.html) continue;

      const hash = contentHash(formatted.html);
      const tracked = trackedMessages.get(element.id);

      if (tracked) {
        if (tracked.hash === hash) continue;
        try {
          await apiEdit(tracked.msgIds[0], formatted.html);
          tracked.hash = hash;
          console.log(`[${elapsed(startTime)}] EDIT  ${element.type} msgId=${tracked.msgIds[0]} "${stripHtml(formatted.html)}"`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (!msg.includes('not modified') && !msg.includes('not found')) {
            console.warn(`[${elapsed(startTime)}] EDIT FAILED: ${msg}`);
          }
        }
      } else {
        const msgId = await apiSend(formatted.html);
        trackedMessages.set(element.id, { msgIds: [msgId], hash });
        console.log(`[${elapsed(startTime)}] SEND  ${element.type} "${stripHtml(formatted.html)}" -> msgId=${msgId}`);
      }
    }

    prevState = state;
  }

  // Clean up activity if still present
  if (activityMsgId) {
    await apiDelete(activityMsgId);
    console.log(`[${elapsed(startTime)}] DELETE activity msgId=${activityMsgId} (end of recording)`);
  }

  console.log(`\n[replay] Done — ${trackedMessages.size} content messages, ${lines.length} snapshots replayed`);
  process.exit(0);
}

main().catch(err => {
  console.error('[replay] Fatal:', err);
  process.exit(1);
});
