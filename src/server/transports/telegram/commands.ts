import type { StateManager } from '../../state-manager.js';
import type { CommandExecutor } from '../../command-executor.js';
import type { CDPBridge } from '../../cdp-bridge.js';
import type { TopicManager } from './topic-manager.js';
import type { MessageTracker } from '../message-tracker.js';
import type { WindowMonitor } from '../../window-monitor.js';
import { escapeHtml, formatElement, formatPlanFull, mergeFormattedBlocks, splitMessage } from './formatter.js';
import type { PlanBlock } from '../../types.js';
import { cleanTabTitle } from '../../dom-extractor.js';
import { normalizeWindowTitle } from './topic-manager.js';
import { tgKeyboard, type BotContext, type TelegramApiClient } from './tg-types.js';

export interface CommandDeps {
  api: TelegramApiClient;
  stateManager: StateManager;
  commandExecutor: CommandExecutor;
  cdpBridge: CDPBridge;
  topicManager: TopicManager;
  messageTracker: MessageTracker;
  windowMonitor: WindowMonitor;
  chatId: number | undefined;
  getSyncEnabled: () => boolean;
  setSyncEnabled: (enabled: boolean, chatId?: number) => void;
  setChatId: (id: number) => void;
  resetAllState: () => void;
}

export interface RegisterDeps {
  authState: { token: string };
  registeredUsers: Set<number>;
  registerUser: (id: number, username?: string, firstName?: string) => void;
}

function genId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFreshExtraction(stateManager: StateManager, genBefore: number, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (stateManager.generation <= genBefore && Date.now() < deadline) {
    await sleep(200);
  }
}

const TOPIC_CREATE_DELAY_MS = 1500;
const PURGE_SCAN_MAX = 10000;
const DEFAULT_HISTORY_COUNT = 5;

// --- /register ---

export async function handleRegister(ctx: BotContext, deps: RegisterDeps): Promise<void> {
  const token = (ctx.match ?? '').trim();

  if (!token) {
    await ctx.reply('Usage: /register <token>\n\nGet the token from the server console log.');
    return;
  }

  if (token !== deps.authState.token) {
    await ctx.reply('Invalid token.');
    return;
  }

  const userId = ctx.from?.id;
  if (!userId) return;

  const username = ctx.from?.username;
  const firstName = ctx.from?.first_name;
  const displayName = username ? `@${username}` : firstName ?? String(userId);
  deps.registerUser(userId, username, firstName);
  await ctx.reply(`Registered ${displayName}! You can now use all bot commands.`);
  console.log(`[telegram] Registered: ${displayName} (ID: ${userId})`);
}

// --- /sync ---

export async function handleSync(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (ctx.chat?.type !== 'supergroup') {
    await ctx.reply(
      '⚠️ This is not a supergroup.\n\n' +
      '1. Open Group Settings\n' +
      '2. Enable Topics (auto-converts to supergroup)\n' +
      '3. Run /sync again'
    );
    return;
  }

  const isForum = ctx.chat?.is_forum === true;
  if (!isForum) {
    await ctx.reply(
      '⚠️ Forum topics are not enabled.\n\n' +
      '1. Open Group Settings > Topics > Enable\n' +
      '2. Run /sync again\n\n' +
      'The bot cannot enable topics — only the group owner can.'
    );
    return;
  }

  try {
    const me = await deps.api.getMe();
    const member = await deps.api.getChatMember(chatId, me.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
      await ctx.reply(
        '⚠️ Bot is not an admin.\n\n' +
        'Go to Group Settings > Administrators > Add bot with these permissions:\n' +
        '• Manage Topics\n' +
        '• Delete Messages\n' +
        '• Pin Messages\n\n' +
        'Then run /sync again.'
      );
      return;
    }
    if (member.status === 'administrator') {
      const missing: string[] = [];
      if (!member.can_manage_topics) missing.push('Manage Topics');
      if (!member.can_delete_messages) missing.push('Delete Messages');
      if (!member.can_pin_messages) missing.push('Pin Messages');
      if (missing.length > 0) {
        await ctx.reply(
          `⚠️ Bot is missing permissions: ${missing.join(', ')}\n\n` +
          'Go to Group Settings > Administrators > Bot > enable the missing permissions.\n' +
          'Then run /sync again.'
        );
        return;
      }
    }
  } catch (err) {
    console.warn(`[telegram] Admin check failed: ${err instanceof Error ? err.message : err}`);
  }

  // Switching to a different group — clear stale state from the old one
  if (deps.chatId && deps.chatId !== chatId) {
    console.log(`[telegram] Group changed ${deps.chatId} → ${chatId}, clearing old state`);
    deps.resetAllState();
    deps.topicManager.resetHighWaterMark();
  }

  deps.setSyncEnabled(true, chatId);

  const state = deps.stateManager.getCurrentState();
  if (!state.connected || state.windows.length === 0) {
    await ctx.reply('✅ Sync enabled. Cursor not connected yet — topics will be created automatically when it connects.');
    return;
  }

  const snapshots = deps.windowMonitor.getAllSnapshots();
  console.log(`[telegram] /sync: ${state.windows.length} windows, ${snapshots.size} snapshots`);
  for (const [wid, snap] of snapshots) {
    const at = snap.chatTabs.find(t => t.isActive);
    console.log(`  [${wid.substring(0, 8)}] "${snap.windowTitle}" tabs=${snap.chatTabs.length} msgs=${snap.messages.length} active="${at?.title ?? 'none'}" agent=${snap.agentStatus}`);
  }
  const toCreate: Array<{ snapshot: typeof snapshots extends Map<string, infer V> ? V : never; tabTitle: string }> = [];
  let tabsWithMessages = 0;

  for (const [, snapshot] of snapshots) {
    if (snapshot.messages.length === 0) continue;
    const activeTab = snapshot.chatTabs.find(t => t.isActive)
      ?? (snapshot.chatTabs.length === 1 ? snapshot.chatTabs[0] : undefined);
    if (!activeTab) continue;
    tabsWithMessages++;
    const cleaned = cleanTabTitle(activeTab.title);
    if (deps.topicManager.getThreadForSnapshot(snapshot.windowId, snapshot.windowTitle, cleaned)) continue;
    toCreate.push({ snapshot, tabTitle: cleaned });
  }

  if (toCreate.length === 0) {
    if (tabsWithMessages === 0) {
      const snapshotCount = snapshots.size;
      const withTabs = Array.from(snapshots.values()).filter(s => s.chatTabs.length > 0).length;
      await ctx.reply(
        `✅ Sync enabled. No active tabs with messages found yet — topics will be auto-created as conversations start.\n` +
        `(${snapshotCount} window(s) monitored, ${withTabs} with tabs)`
      );
    } else {
      await ctx.reply('✅ Sync enabled. All topics already exist.');
    }
    return;
  }

  await ctx.reply(`✅ Sync enabled. Creating ${toCreate.length} topic(s) in background. Bot stays responsive.`);

  doSyncInBackground(deps.api, chatId, toCreate, deps.topicManager).catch(err => {
    console.error('[telegram] Sync background error:', err);
  });
}

// --- /sync_all ---

export async function handleSyncAll(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  if (!deps.getSyncEnabled()) {
    await ctx.reply('⚠️ Sync not enabled. Run /sync first.');
    return;
  }

  const seenKeys = new Set<string>();
  const toCreate: SnapshotEntry[] = [];
  let tabsWithMessages = 0;

  for (const [, snapshot] of deps.windowMonitor.getAllSnapshots()) {
    if (snapshot.messages.length === 0) continue;
    const activeTab = snapshot.chatTabs?.find(t => t.isActive)
      ?? (snapshot.chatTabs?.length === 1 ? snapshot.chatTabs[0] : undefined);
    if (!activeTab) continue;
    tabsWithMessages++;
    const cleaned = cleanTabTitle(activeTab.title);
    const key = `${snapshot.windowId}::${cleaned.toLowerCase()}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (deps.topicManager.getThreadForSnapshot(snapshot.windowId, snapshot.windowTitle, cleaned)) continue;
    toCreate.push({ snapshot, tabTitle: cleaned });
  }

  if (toCreate.length === 0) {
    if (tabsWithMessages === 0) {
      await ctx.reply('No active tabs with messages found. Start a conversation in Cursor first, then try again.');
    } else {
      await ctx.reply('All tabs already have topics.');
    }
    return;
  }

  await ctx.reply(`Creating topics for ${toCreate.length} tab(s) in background...`);

  doSyncInBackground(deps.api, chatId, toCreate, deps.topicManager).catch(err => {
    console.error('[telegram] Sync_all background error:', err);
  });
}

type SnapshotEntry = { snapshot: { windowId: string; windowTitle: string; messages: import('../../types.js').ChatElement[]; chatTabs?: import('../../types.js').ChatTab[] }; tabTitle: string };

async function doSyncInBackground(
  api: TelegramApiClient,
  chatId: number,
  toCreate: SnapshotEntry[],
  topicManager: TopicManager
): Promise<void> {
  let created = 0;
  const noopHash = () => 'noop';

  for (const { snapshot, tabTitle } of toCreate) {
    const cleanedTab = cleanTabTitle(tabTitle);
    const topicName = `${snapshot.windowTitle} — ${cleanedTab}`.substring(0, 128);
    try {
      await sleep(500);
      const result = await api.createForumTopic(chatId, topicName);
      const threadId = result.message_thread_id;
      topicManager.registerMapping({
        threadId,
        windowId: snapshot.windowId,
        windowTitle: snapshot.windowTitle,
        tabTitle: cleanedTab,
        lastActive: Date.now(),
      });
      created++;

      const activeTab = snapshot.chatTabs?.find((t: { isActive: boolean }) => t.isActive);
      if (activeTab && cleanTabTitle(activeTab.title) === cleanedTab && snapshot.messages.length > 0) {
        const last5 = snapshot.messages.slice(-5);
        for (const el of last5) {
          if (el.type === 'loading') continue;
          const fmt = formatElement(el, noopHash);
          if (!fmt.html) continue;
          try {
            await api.sendMessage(chatId, fmt.html, {
              message_thread_id: threadId,
              parse_mode: 'HTML',
            });
          } catch {
            try {
              await api.sendMessage(chatId, fmt.html.replace(/<[^>]*>/g, ''), {
                message_thread_id: threadId,
              });
            } catch { /* skip */ }
          }
          await sleep(200);
        }
      }
    } catch (err) {
      console.warn(`[telegram] Sync: failed "${topicName}": ${err instanceof Error ? err.message : err}`);
    }
  }

  const total = topicManager.getAllMappings().length;
  try {
    await api.sendMessage(chatId, `✅ Sync complete. ${created} topic(s) created, ${total} total.`);
  } catch { /* ok */ }
}

// --- /unsync ---

export async function handleUnsync(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  const mappings = deps.topicManager.getAllMappings();

  deps.setSyncEnabled(false);

  if (mappings.length === 0) {
    await ctx.reply('Sync disabled. No tracked topics to delete.');
    return;
  }

  await ctx.reply(`🗑 Disabling sync and deleting ${mappings.length} tracked topic(s)...`);

  let deleted = 0;
  for (const mapping of mappings) {
    try {
      await deps.api.deleteForumTopic(chatId, mapping.threadId);
      deleted++;
      await sleep(TOPIC_CREATE_DELAY_MS);
    } catch { /* already deleted */ }
  }

  deps.resetAllState();

  await ctx.reply(`✅ Sync disabled. Deleted ${deleted}/${mappings.length} topic(s).`);
  console.log(`[telegram] Unsync: deleted ${deleted} topics, cleared all state`);
}

// --- /cleanup ---

export async function handleCleanup(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  const trackedIds = new Set(deps.topicManager.getAllMappings().map(m => m.threadId));
  if (trackedIds.size === 0) {
    await ctx.reply('No tracked topics. Use /purge to delete everything.');
    return;
  }

  const maxId = deps.topicManager.highWaterMark;
  const scanUpTo = maxId + 200;

  await ctx.reply(`🧹 Cleaning untracked topics (keeping ${trackedIds.size} tracked)...`);

  doCleanupInBackground(deps.api, chatId, trackedIds, scanUpTo).catch(err => {
    console.error('[telegram] Cleanup error:', err);
  });
}

async function doCleanupInBackground(api: TelegramApiClient, chatId: number, trackedIds: Set<number>, scanUpTo: number): Promise<void> {
  let deleted = 0;

  for (let threadId = 2; threadId <= scanUpTo; threadId++) {
    if (trackedIds.has(threadId)) continue;
    try {
      await api.deleteForumTopic(chatId, threadId);
      deleted++;
      await sleep(500);
    } catch { /* doesn't exist */ }
  }

  try {
    await api.sendMessage(chatId, `🧹 Cleanup done: ${deleted} untracked topic(s) deleted.`);
  } catch { /* ok */ }
  console.log(`[telegram] Cleanup: ${deleted} deleted, ${trackedIds.size} kept`);
}

// --- /resync ---

export async function handleResync(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await ctx.reply('⚠️ Run /resync inside the topic you want to rebind, not the General chat.');
    return;
  }

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply('⚠️ This topic isn\'t tracked yet. Run /sync first to create the initial mapping.');
    return;
  }

  await deps.cdpBridge.refreshWindows();
  deps.stateManager.updateWindows(deps.cdpBridge.windows, deps.cdpBridge.activeTargetId);
  const state = deps.stateManager.getCurrentState();

  // Resolve the new (window, tab) target. Two paths:
  //   - No argument: use the CDP-active window's active tab from global state.
  //     Works when the user has already focused the right window in Cursor.
  //   - Argument: match a window by name (case-insensitive substring) and read
  //     that window's per-window snapshot to find its active tab. Necessary
  //     when the relay's home is *not* the window the user wants — common
  //     with Cursor's global agent rail where multiple windows can host the
  //     same agent and only one of them is the CDP home.
  const arg = (ctx.match ?? '').trim();
  let targetWin: typeof state.windows[number] | undefined;
  let targetTabTitle: string | undefined;

  if (arg) {
    const argLower = arg.toLowerCase();
    const candidates = state.windows.filter((w) => w.title.toLowerCase().includes(argLower));
    if (candidates.length === 0) {
      await ctx.reply(
        `⚠️ No Cursor window matches "${arg}".\n\nKnown windows:\n` +
        state.windows.map((w) => `• ${w.title}`).join('\n')
      );
      return;
    }
    if (candidates.length > 1) {
      await ctx.reply(
        `⚠️ Multiple windows match "${arg}". Use a more specific name:\n` +
        candidates.map((w) => `• ${w.title}`).join('\n')
      );
      return;
    }
    targetWin = candidates[0];
    const snapshot = deps.windowMonitor.getAllSnapshots().get(targetWin.id);
    if (!snapshot || snapshot.chatTabs.length === 0) {
      await ctx.reply(
        `⚠️ Window "${targetWin.title}" has no chat tabs visible yet — window-monitor hasn't extracted them. Wait a poll cycle (~10s) and try again.`
      );
      return;
    }
    const activeTab = snapshot.chatTabs.find((t) => t.isActive)
      ?? (snapshot.chatTabs.length === 1 ? snapshot.chatTabs[0] : undefined);
    if (!activeTab) {
      await ctx.reply(
        `⚠️ Window "${targetWin.title}" has ${snapshot.chatTabs.length} chat tab(s) but none marked active in the DOM. ` +
        `Click a chat in that window's Cursor sidebar, then try again.`
      );
      return;
    }
    targetTabTitle = activeTab.title;
  } else {
    targetWin = state.windows.find((w) => w.id === state.activeWindowId);
    const activeTab = state.chatTabs.find((t) => t.isActive)
      ?? (state.chatTabs.length === 1 ? state.chatTabs[0] : undefined);
    if (!targetWin || !activeTab) {
      await ctx.reply(
        `⚠️ Can't determine the active Cursor window/tab.\n\n` +
        `activeWindow: ${targetWin?.title ?? '(none)'}\n` +
        `activeTab: ${activeTab?.title ?? '(none)'}\n\n` +
        `Either focus the Cursor window+chat you want and run /resync again, or pass a window name:\n` +
        `<code>/resync &lt;part of window name&gt;</code>\n\n` +
        `Available windows:\n` +
        state.windows.map((w) => `• ${w.title}`).join('\n'),
        { parse_mode: 'HTML' }
      );
      return;
    }
    targetTabTitle = activeTab.title;
  }

  const activeWin = targetWin;
  const activeTab = { title: targetTabTitle };

  const cleanedTab = cleanTabTitle(activeTab.title);
  const oldLabel = `${mapping.windowTitle} — ${mapping.tabTitle}`;
  const newLabel = `${activeWin.title} — ${cleanedTab}`;

  if (
    mapping.windowId === activeWin.id &&
    mapping.windowTitle === activeWin.title &&
    cleanTabTitle(mapping.tabTitle) === cleanedTab
  ) {
    await ctx.reply(`✅ Already bound to: ${escapeHtml(newLabel)}`, { parse_mode: 'HTML' });
    return;
  }

  // Refuse if the new (windowId, tab) is already mapped to a different topic —
  // that would create the duplicate-topic problem we just spent the night fixing.
  const collision = deps.topicManager.getThreadForSnapshot(activeWin.id, activeWin.title, cleanedTab);
  if (collision && collision !== threadId) {
    await ctx.reply(
      `⚠️ Cursor's active (window, tab) is already bound to topic ${collision}.\n\n` +
      `Move messages there manually or use /dedupe to consolidate.`
    );
    return;
  }

  const updated = deps.topicManager.updateMappingTarget(threadId, activeWin.id, activeWin.title, cleanedTab);
  if (!updated) {
    await ctx.reply('⚠️ Failed to update mapping (threadId disappeared).');
    return;
  }

  // Best-effort topic rename. If the bot lacks Manage Topics permission this
  // throws; the mapping update still stands so future banners route correctly,
  // the topic name just stays stale until the user fixes permissions.
  let renamed = true;
  try {
    await deps.api.editForumTopic(chatId, threadId, newLabel.substring(0, 128));
  } catch (err) {
    renamed = false;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[telegram] Rename topic ${threadId} failed: ${msg}`);
  }

  const lines = [
    `✅ Topic ${threadId} rebound.`,
    `<b>From:</b> ${escapeHtml(oldLabel)}`,
    `<b>To:</b> ${escapeHtml(newLabel)}`,
  ];
  if (!renamed) {
    lines.push('');
    lines.push('<i>Note:</i> couldn\'t rename the Telegram topic — bot is missing the <b>Manage Topics</b> permission. Mapping is updated; future banners will go here.');
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// --- /dedupe ---

export async function handleDedupe(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  const arg = (ctx.match ?? '').trim().toLowerCase();
  const confirm = arg === 'yes' || arg === 'confirm';

  // Group duplicates two ways:
  //   1. Same Cursor agent (data-composer-id matches) — strongest signal,
  //      these are unambiguously the same chat seen via different windows.
  //   2. Same normalized (windowTitle, tabTitle) — catches WSL/SSH-suffix
  //      variants of the same project from prior sessions.
  // composerId-based grouping wins when both apply, because it's the only
  // reliable cross-window-shape identity Cursor exposes.
  const mappings = deps.topicManager.getAllMappings();
  const groups = new Map<string, typeof mappings>();
  for (const m of mappings) {
    const key = m.composerId
      ? `composer::${m.composerId}`
      : `title::${normalizeWindowTitle(m.windowTitle).toLowerCase()}::${cleanTabTitle(m.tabTitle).toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }

  const dupGroups = Array.from(groups.values()).filter((g) => g.length > 1);
  if (dupGroups.length === 0) {
    await ctx.reply('✅ No duplicate topics. Each (project, tab) maps to exactly one Telegram topic.');
    return;
  }

  // For each duplicate group, the most-recently-active mapping wins; the rest
  // are orphans we'll delete.
  const keep: typeof mappings = [];
  const drop: typeof mappings = [];
  for (const group of dupGroups) {
    const sorted = [...group].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    keep.push(sorted[0]);
    drop.push(...sorted.slice(1));
  }

  if (!confirm) {
    const lines: string[] = [];
    lines.push(`<b>${dupGroups.length} duplicate group(s)</b> — would delete <b>${drop.length}</b> orphan topic(s):`);
    lines.push('');
    for (const group of dupGroups.slice(0, 10)) {
      const sorted = [...group].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
      const title = `${normalizeWindowTitle(sorted[0].windowTitle)} — ${sorted[0].tabTitle}`;
      lines.push(`<b>${escapeHtml(title)}</b>`);
      for (let i = 0; i < sorted.length; i++) {
        const m = sorted[i];
        const marker = i === 0 ? '✅ keep' : '🗑 drop';
        lines.push(`  ${marker} thread=${m.threadId} window="${escapeHtml(m.windowTitle)}"`);
      }
      lines.push('');
    }
    if (dupGroups.length > 10) lines.push(`…and ${dupGroups.length - 10} more group(s).`);
    lines.push('Run <code>/dedupe yes</code> to delete the orphans.');
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
    return;
  }

  await ctx.reply(`🧹 Deduping: deleting ${drop.length} orphan topic(s) across ${dupGroups.length} group(s)...`);

  doDedupeInBackground(deps, chatId, drop).catch((err) => {
    console.error('[telegram] Dedupe error:', err);
  });
}

async function doDedupeInBackground(
  deps: CommandDeps,
  chatId: number,
  drop: import('./topic-manager.js').TopicMapping[]
): Promise<void> {
  let deleted = 0;
  let failed = 0;
  for (const m of drop) {
    try {
      await deps.api.deleteForumTopic(chatId, m.threadId);
      deleted++;
    } catch {
      failed++;
    }
    deps.topicManager.removeMapping(m.threadId);
    await sleep(TOPIC_CREATE_DELAY_MS);
  }
  try {
    const summary = failed === 0
      ? `✅ Dedupe done: removed ${deleted} orphan topic(s).`
      : `✅ Dedupe done: removed ${deleted} orphan topic(s) (${failed} delete call(s) failed — those mappings were still untracked).`;
    await deps.api.sendMessage(chatId, summary);
  } catch { /* ok */ }
  console.log(`[telegram] Dedupe: deleted ${deleted}/${drop.length}, ${failed} delete failures`);
}

// --- /purge ---

export async function handlePurge(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const chatId = deps.chatId ?? ctx.chat?.id;
  if (!chatId) return;

  deps.setSyncEnabled(false);
  await ctx.reply('🗑 Purging all topics in background...');

  doPurgeInBackground(deps.api, chatId, deps).catch(err => {
    console.error('[telegram] Purge error:', err);
  });
}

async function doPurgeInBackground(api: TelegramApiClient, chatId: number, deps: CommandDeps): Promise<void> {
  let deleted = 0;
  let consecutiveMisses = 0;

  const maxKnown = Math.max(
    deps.topicManager.highWaterMark,
    deps.topicManager.getAllMappings().reduce((max, m) => Math.max(max, m.threadId), 0)
  );

  // When we have no HWM data (e.g. fresh group), use a shorter scan with aggressive early exit
  const hasHwm = maxKnown > 0;
  const scanUpTo = hasHwm ? maxKnown + 200 : PURGE_SCAN_MAX;
  const earlyExitThreshold = hasHwm ? 200 : 50;

  console.log(`[telegram] Purge started: scanning 2–${scanUpTo} (high water: ${maxKnown})`);

  for (let threadId = 2; threadId <= scanUpTo; threadId++) {
    if (consecutiveMisses > earlyExitThreshold && (!hasHwm || threadId > maxKnown + 100)) {
      console.log(`[telegram] Purge: early exit at ${threadId} (${consecutiveMisses} consecutive misses)`);
      break;
    }
    if ((threadId - 2) % 200 === 0 && threadId > 2) {
      console.log(`[telegram] Purge progress: ${threadId}/${scanUpTo}, deleted ${deleted}`);
    }
    try {
      await api.deleteForumTopic(chatId, threadId);
      deleted++;
      consecutiveMisses = 0;
      await sleep(500);
    } catch {
      consecutiveMisses++;
    }
  }

  deps.resetAllState();

  let msg = `✅ Purge complete: ${deleted} topic(s) deleted. Run /sync to set up.`;
  if (deleted === 0) {
    msg = '✅ No topics found — group is clean. Run /sync to set up.';
  }

  try {
    await api.sendMessage(chatId, msg);
  } catch { /* ok */ }
  console.log(`[telegram] Purge done: ${deleted} deleted, scanned to ${scanUpTo}`);
}

// --- /status ---

export async function handleStatus(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const state = deps.stateManager.getCurrentState();
  const activeWin = state.windows.find(w => w.id === state.activeWindowId);
  const activeTab = state.chatTabs.find(t => t.isActive);
  const syncOn = deps.getSyncEnabled();
  const groupId = deps.chatId;

  const lines = [
    '<b>Status</b>',
    '',
    `Sync: ${syncOn ? '✅ On' : '❌ Off'}`,
    `Group: ${groupId ? String(groupId) : 'Not set (run /sync)'}`,
    `Connection: ${state.connected ? '✅ Connected' : '❌ Disconnected'}`,
    `Agent: ${escapeHtml(state.agentStatus)}`,
    `Window: ${activeWin ? escapeHtml(activeWin.title) : 'None'}`,
    `Tab: ${activeTab ? escapeHtml(activeTab.title) : 'None'}`,
    `Mode: ${escapeHtml(state.mode.current)}`,
    `Model: ${escapeHtml(state.model.current)}`,
    `Windows: ${state.windows.length}`,
    `Topics: ${deps.topicManager.getAllMappings().length}`,
    `Approvals: ${state.pendingApprovals.length}`,
  ];
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// --- /history ---

export async function handleHistory(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const state = deps.stateManager.getCurrentState();

  const countArg = ctx.match ? parseInt(ctx.match.trim(), 10) : NaN;
  const count = isNaN(countArg) || countArg <= 0 ? DEFAULT_HISTORY_COUNT : countArg;

  const threadId = ctx.message?.message_thread_id;
  const mapping = threadId ? deps.topicManager.resolveThread(threadId) : undefined;

  if (!mapping) {
    await ctx.reply('⚠️ This topic is not mapped to a Cursor window/tab. Run /sync or /sync_all first.');
    return;
  }

  let windowTitle = `${mapping.windowTitle} / ${mapping.tabTitle}`;
  let messages: import('../../types.js').ChatElement[] = [];
  let targetWindowId: string | undefined;

  let targetWin = state.windows.find(w => w.id === mapping.windowId);
  if (!targetWin) {
    targetWin = state.windows.find(w => w.title.toLowerCase() === mapping.windowTitle.toLowerCase());
    if (targetWin) mapping.windowId = targetWin.id;
  }
  targetWindowId = targetWin?.id;

  if (!targetWin || !targetWindowId) {
    await ctx.reply(`⚠️ Window "${mapping.windowTitle}" not found. Is Cursor open?`);
    return;
  }

  const cleanedMapping = cleanTabTitle(mapping.tabTitle).toLowerCase();
  if (targetWin.id === state.activeWindowId && state.messages.length > 0) {
    const activeTab = state.chatTabs.find(t => t.isActive);
    if (activeTab && cleanTabTitle(activeTab.title).toLowerCase() === cleanedMapping) {
      messages = state.messages;
    }
  }

  console.log(`[telegram] /history ${count} for "${windowTitle}"`);

  // Switch to target window/tab and read fresh extraction
  if (targetWindowId) {
    if (targetWindowId !== state.activeWindowId) {
      try {
        const genBefore = deps.stateManager.generation;
        await deps.cdpBridge.switchWindow(targetWindowId);
        deps.windowMonitor.setHomeWindow(targetWindowId);
        await waitForFreshExtraction(deps.stateManager, genBefore, 4000);
      } catch {
        // Stay on current
      }
    }

    if (mapping) {
      const midState = deps.stateManager.getCurrentState();
      const activeTab = midState.chatTabs.find(t => t.isActive);
      const cleanedMapping = cleanTabTitle(mapping.tabTitle).toLowerCase();
      if (!activeTab || cleanTabTitle(activeTab.title).toLowerCase() !== cleanedMapping) {
        const genBefore = deps.stateManager.generation;
        await deps.commandExecutor.switchTab(genId(), mapping.tabTitle);
        await waitForFreshExtraction(deps.stateManager, genBefore, 4000);
      }
    }

    const freshState = deps.stateManager.getCurrentState();
    const activeTab = freshState.chatTabs.find(t => t.isActive);
    const tabMatches = activeTab && cleanTabTitle(activeTab.title).toLowerCase() === cleanedMapping;
    if (freshState.messages.length > 0 && tabMatches) {
      messages = freshState.messages;
    } else if (freshState.messages.length > 0 && !tabMatches) {
      console.warn(`[telegram] /history: tab mismatch after switch (active="${activeTab?.title}", expected="${mapping.tabTitle}")`);
    }

    // Scroll up if we need more
    if (messages.length < count) {
      const scrollTimes = Math.min(Math.ceil(count / 15), 10);
      await ctx.reply(`📜 Loading older messages (scrolling ${scrollTimes}x)...`);

      await deps.commandExecutor.scrollChatUp(genId(), scrollTimes);
      await sleep(2000);

      const afterScroll = deps.stateManager.getCurrentState();
      if (afterScroll.messages.length > messages.length) {
        messages = afterScroll.messages;
      }

      await deps.commandExecutor.scrollChatToBottom(genId());
    }
  }

  const sliced = messages.slice(-count);
  if (sliced.length === 0) {
    await ctx.reply(`No messages found for "${windowTitle}".`);
    return;
  }

  const noopHash = () => 'noop';

  await ctx.reply(`📜 <b>History</b> "${escapeHtml(windowTitle)}" — ${sliced.length} messages`, { parse_mode: 'HTML' });

  let pendingBlocks: string[] = [];

  async function flushPending() {
    if (pendingBlocks.length === 0) return;
    const chunks = mergeFormattedBlocks(pendingBlocks);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      } catch {
        try {
          await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
        } catch { /* skip */ }
      }
      await sleep(300);
    }
    pendingBlocks = [];
  }

  for (const element of sliced) {
    if (element.type === 'loading') continue;
    const formatted = formatElement(element, noopHash);
    if (!formatted.html) continue;

    if (formatted.keyboard) {
      await flushPending();
      try {
        await ctx.reply(formatted.html, { parse_mode: 'HTML', reply_markup: formatted.keyboard });
      } catch {
        try {
          await ctx.reply(formatted.html.replace(/<[^>]*>/g, ''), { reply_markup: formatted.keyboard });
        } catch { /* skip */ }
      }
      await sleep(300);
    } else {
      pendingBlocks.push(formatted.html);
    }
  }

  await flushPending();
}

// --- helpers ---

function getThreadIdFromContext(ctx: BotContext): number | undefined {
  return ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
}

async function ensureTopicWindow(ctx: BotContext, deps: CommandDeps): Promise<boolean> {
  const threadId = getThreadIdFromContext(ctx);
  if (!threadId) return true;

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) return true;

  const state = deps.stateManager.getCurrentState();
  const currentWin = state.windows.find(w => w.id === state.activeWindowId);
  const alreadyOnWindow = currentWin && (
    currentWin.id === mapping.windowId ||
    currentWin.title.toLowerCase() === mapping.windowTitle.toLowerCase()
  );

  if (!alreadyOnWindow) {
    await deps.cdpBridge.refreshWindows();
    deps.stateManager.updateWindows(deps.cdpBridge.windows, deps.cdpBridge.activeTargetId);
    const freshState = deps.stateManager.getCurrentState();

    let targetWin = freshState.windows.find(w => w.id === mapping.windowId);
    if (!targetWin) {
      targetWin = freshState.windows.find(w => w.title.toLowerCase() === mapping.windowTitle.toLowerCase());
      if (targetWin) mapping.windowId = targetWin.id;
    }

    if (!targetWin) {
      await ctx.reply(`⚠️ Window "${mapping.windowTitle}" not found.`);
      return false;
    }

    try {
      const genBefore = deps.stateManager.generation;
      await deps.cdpBridge.switchWindow(targetWin.id);
      deps.windowMonitor.setHomeWindow(targetWin.id);
      await waitForFreshExtraction(deps.stateManager, genBefore, 4000);
    } catch {
      await ctx.reply('⚠️ Failed to switch to the target window.');
      return false;
    }
  }

  const afterState = deps.stateManager.getCurrentState();
  const activeTab = afterState.chatTabs.find(t => t.isActive);
  const cleanedMapping = cleanTabTitle(mapping.tabTitle).toLowerCase();
  if (!activeTab || cleanTabTitle(activeTab.title).toLowerCase() !== cleanedMapping) {
    try {
      const genBefore = deps.stateManager.generation;
      await deps.commandExecutor.switchTab(genId(), mapping.tabTitle);
      await waitForFreshExtraction(deps.stateManager, genBefore, 3000);
    } catch { /* best-effort */ }
  }

  return true;
}

// --- /mode, /model, /plan, /agent ---


export async function handleMode(ctx: BotContext, deps: CommandDeps): Promise<void> {
  if (!await ensureTopicWindow(ctx, deps)) return;

  const state = deps.stateManager.getCurrentState();
  const activeWin = state.windows.find(w => w.id === state.activeWindowId);
  const activeTab = state.chatTabs.find(t => t.isActive);
  console.log(`[telegram] /mode for "${activeWin?.title ?? '?'}" / "${activeTab?.title ?? '?'}" → ${state.mode.current}`);

  const kb = tgKeyboard();
  for (const mode of state.mode.available) {
    const current = mode.id === state.mode.current ? ' ✓' : '';
    kb.text(`${mode.label}${current}`, `mode:${mode.id}`);
  }
  await ctx.reply(
    `<b>Current mode:</b> ${escapeHtml(state.mode.current)}`,
    { parse_mode: 'HTML', reply_markup: kb.build() }
  );
}

export async function handleModel(ctx: BotContext, deps: CommandDeps): Promise<void> {
  if (!await ensureTopicWindow(ctx, deps)) return;

  const state = deps.stateManager.getCurrentState();
  const activeWin = state.windows.find(w => w.id === state.activeWindowId);
  const activeTab = state.chatTabs.find(t => t.isActive);
  console.log(`[telegram] /model for "${activeWin?.title ?? '?'}" / "${activeTab?.title ?? '?'}" → ${state.model.current}`);

  const result = await deps.commandExecutor.getModelOptions(genId());
  const raw = result.data as { options?: { id: string; label: string; selected?: boolean }[] } | undefined;
  const options = result.ok && Array.isArray(raw?.options) ? raw.options : [];

  if (options.length === 0) {
    await ctx.reply(
      `<b>Current model:</b> ${escapeHtml(state.model.current)}\n<i>Could not load model list from Cursor.</i>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const kb = tgKeyboard();
  const currentLower = state.model.current.toLowerCase();
  const buttonsPerRow = 2;
  for (let i = 0; i < options.length; i++) {
    const m = options[i];
    const isCurrent = currentLower === m.label.toLowerCase() ||
      state.model.currentId === m.id || m.selected;
    const suffix = isCurrent ? ' ✓' : '';
    kb.text(`${m.label}${suffix}`, `model:${m.id}`);
    if ((i + 1) % buttonsPerRow === 0 || i === options.length - 1) {
      kb.row();
    }
  }
  await ctx.reply(
    `<b>Current model:</b> ${escapeHtml(state.model.current)}`,
    { parse_mode: 'HTML', reply_markup: kb.build() }
  );
}

export async function handlePlanCommand(ctx: BotContext, deps: CommandDeps): Promise<void> {
  if (!await ensureTopicWindow(ctx, deps)) return;

  const text = ctx.match;
  if (!text?.trim()) {
    await ctx.reply('Usage: /plan <your prompt>');
    return;
  }

  const state = deps.stateManager.getCurrentState();
  if (state.mode.current !== 'plan') {
    const result = await deps.commandExecutor.setMode(genId(), 'plan');
    if (!result.ok) {
      await ctx.reply(`⚠️ Failed to switch to Plan mode: ${result.error}`);
      return;
    }
    await sleep(500);
  }

  const result = await deps.commandExecutor.sendMessage(genId(), String(text));
  if (!result.ok) await ctx.reply(`⚠️ Failed to send: ${result.error}`);
}

export async function handleAgentCommand(ctx: BotContext, deps: CommandDeps): Promise<void> {
  if (!await ensureTopicWindow(ctx, deps)) return;

  const text = ctx.match;
  if (!text?.trim()) {
    await ctx.reply('Usage: /agent <your prompt>');
    return;
  }

  const state = deps.stateManager.getCurrentState();
  if (state.mode.current !== 'agent') {
    const result = await deps.commandExecutor.setMode(genId(), 'agent');
    if (!result.ok) {
      await ctx.reply(`⚠️ Failed to switch to Agent mode: ${result.error}`);
      return;
    }
    await sleep(500);
  }

  const result = await deps.commandExecutor.sendMessage(genId(), String(text));
  if (!result.ok) await ctx.reply(`⚠️ Failed to send: ${result.error}`);
}

// --- Callback queries ---

const ACTION_SELECTORS: Record<string, string> = {
  bld: '.composer-create-plan-build-button',
  run: '.composer-tool-call-status-row .anysphere-button.composer-run-button',
  skp: '.composer-skip-button',
  alw: '.composer-tool-call-status-row .anysphere-secondary-button.composer-run-button',
};

export async function handleCallbackQuery(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery({ text: 'Unknown action' });
    return;
  }

  const parts = data.split(':');
  const action = parts[0];
  const id = parts[1] ?? '';
  const hash = parts[2] ?? '';
  const commandId = genId();

  try {
    if (action === 'mode') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: 'Failed to switch window' });
        return;
      }
      const result = await deps.commandExecutor.setMode(commandId, id);
      await ctx.answerCallbackQuery({ text: result.ok ? `Mode: ${id}` : `Error: ${result.error}` });
      if (result.ok) {
        await ctx.editMessageText(`<b>Current mode:</b> ${escapeHtml(id)}`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (action === 'model') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: 'Failed to switch window' });
        return;
      }
      const label = id.startsWith('label::') ? id.slice(7) : id;
      const result = await deps.commandExecutor.setModel(commandId, id);
      await ctx.answerCallbackQuery({ text: result.ok ? `Model: ${label}` : `Error: ${result.error}` });
      if (result.ok) {
        await ctx.editMessageText(`<b>Current model:</b> ${escapeHtml(label)}`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (action === 'dif') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: 'Failed to switch window' });
        return;
      }
      const toolCallId = deps.messageTracker.resolveHash(hash);
      if (!toolCallId) {
        await ctx.answerCallbackQuery({ text: 'Action expired.' });
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Extracting...' });
      const content = await deps.commandExecutor.extractToolContent(toolCallId);
      if (!content || !content.code) {
        await ctx.reply('Could not extract content — tool call may no longer be in the DOM.');
        return;
      }
      const threadId = getThreadIdFromContext(ctx);
      const langTag = content.language ? ` class="language-${escapeHtml(content.language)}"` : '';
      const header = content.filename ? `<b>${escapeHtml(content.filename)}</b>\n` : '';
      const codeBlock = `${header}<pre><code${langTag}>${escapeHtml(content.code)}</code></pre>`;
      const parts = splitMessage(codeBlock);
      for (const part of parts) {
        try {
          await ctx.reply(part, {
            message_thread_id: threadId,
            parse_mode: 'HTML',
          });
        } catch {
          try {
            await ctx.reply(part.replace(/<[^>]*>/g, ''), { message_thread_id: threadId });
          } catch { /* skip */ }
        }
        await sleep(300);
      }
      return;
    }

    if (action === 'vpl') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: 'Failed to switch window' });
        return;
      }
      const state = deps.stateManager.getCurrentState();
      const planEl = state.messages.find(
        m => m.type === 'plan' && m.id.startsWith(id)
      ) as PlanBlock | undefined;

      if (!planEl) {
        await ctx.answerCallbackQuery({ text: 'Plan not found in current state' });
        return;
      }

      await ctx.answerCallbackQuery({ text: 'Sending plan...' });
      const content = formatPlanFull(planEl);
      const threadId = getThreadIdFromContext(ctx);
      const parts = splitMessage(content);
      for (const part of parts) {
        try {
          await ctx.reply(part, { message_thread_id: threadId, parse_mode: 'HTML' });
        } catch {
          try { await ctx.reply(part.replace(/<[^>]*>/g, ''), { message_thread_id: threadId }); } catch { /* skip */ }
        }
        await sleep(300);
      }
      return;
    }

    // Questionnaire actions — resolve hash directly, no stable selector
    if (action === 'qan' || action === 'qsk' || action === 'qco') {
      if (!(await ensureTopicWindow(ctx, deps))) {
        await ctx.answerCallbackQuery({ text: 'Failed to switch window' });
        return;
      }
      // For questionnaire, the hash is in parts[1] (format: qan:<hash>)
      const qHash = parts[1] ?? '';
      const qSelector = deps.messageTracker.resolveHash(qHash);
      if (!qSelector) {
        await ctx.answerCallbackQuery({ text: 'Action expired.' });
        return;
      }
      const result = await deps.commandExecutor.clickAction(commandId, qSelector);
      const qNames: Record<string, string> = { qan: 'Answered', qsk: 'Skipped', qco: 'Continued' };
      await ctx.answerCallbackQuery({ text: result.ok ? qNames[action] ?? action : `Error: ${result.error}` });
      return;
    }

    if (!(await ensureTopicWindow(ctx, deps))) {
      await ctx.answerCallbackQuery({ text: 'Failed to switch window' });
      return;
    }

    // For known action types, use stable CSS class selectors instead of stale nth-of-type paths
    const stableSelector = ACTION_SELECTORS[action];
    let selectorPath: string | undefined;
    if (stableSelector) {
      selectorPath = stableSelector;
    } else {
      selectorPath = deps.messageTracker.resolveHash(hash);
    }

    if (!selectorPath) {
      await ctx.answerCallbackQuery({ text: 'Action expired.' });
      return;
    }

    let result;
    switch (action) {
      case 'apr': case 'rej': case 'all':
        result = await deps.commandExecutor.clickApproval(commandId, selectorPath);
        break;
      case 'run': case 'skp': case 'alw': case 'bld':
        result = await deps.commandExecutor.clickAction(commandId, selectorPath);
        break;
      default:
        await ctx.answerCallbackQuery({ text: `Unknown: ${action}` });
        return;
    }

    const names: Record<string, string> = {
      apr: 'Approved', rej: 'Rejected', all: 'Accepted All',
      run: 'Running', skp: 'Skipped', alw: 'Allowed',
      bld: 'Building',
    };
    await ctx.answerCallbackQuery({ text: result.ok ? names[action] ?? action : `Error: ${result.error}` });
  } catch (err) {
    await ctx.answerCallbackQuery({ text: `Error: ${err instanceof Error ? err.message : err}` });
  }
}

// --- Text messages ---

export async function handleTextMessage(ctx: BotContext, deps: CommandDeps): Promise<void> {
  const threadId = ctx.message?.message_thread_id;
  const text = ctx.message?.text;
  if (!threadId || !text) return;

  const mapping = deps.topicManager.resolveThread(threadId);
  if (!mapping) {
    await ctx.reply('⚠️ This topic is not mapped. Run /sync to set up.');
    return;
  }

  let state = deps.stateManager.getCurrentState();
  const commandId = genId();

  const currentWin = state.windows.find(w => w.id === state.activeWindowId);
  const alreadyOnWindow = currentWin && (
    currentWin.id === mapping.windowId ||
    currentWin.title.toLowerCase() === mapping.windowTitle.toLowerCase()
  );

  if (!alreadyOnWindow) {
    await deps.cdpBridge.refreshWindows();
    deps.stateManager.updateWindows(deps.cdpBridge.windows, deps.cdpBridge.activeTargetId);
    state = deps.stateManager.getCurrentState();

    let targetWin = state.windows.find(w => w.id === mapping.windowId);
    if (!targetWin) {
      targetWin = state.windows.find(w => w.title.toLowerCase() === mapping.windowTitle.toLowerCase());
      if (targetWin) mapping.windowId = targetWin.id;
    }

    if (!targetWin) {
      await ctx.reply(`⚠️ Window "${mapping.windowTitle}" not found. Open: ${state.windows.map(w => w.title).join(', ') || 'none'}`);
      return;
    }

    try {
      await deps.cdpBridge.switchWindow(targetWin.id);
      deps.windowMonitor.setHomeWindow(targetWin.id);
      await sleep(1500);
    } catch (err) {
      await ctx.reply(`⚠️ Failed to switch window: ${err instanceof Error ? err.message : err}`);
      return;
    }
  } else {
    deps.windowMonitor.setHomeWindow(state.activeWindowId);
  }

  const activeTab = state.chatTabs.find(t => t.isActive);
  const cleanedMapping = cleanTabTitle(mapping.tabTitle);
  if (activeTab && cleanTabTitle(activeTab.title).toLowerCase() !== cleanedMapping.toLowerCase()) {
    const tabResult = await deps.commandExecutor.switchTab(commandId, mapping.tabTitle);
    if (!tabResult.ok) {
      await ctx.reply(`⚠️ Failed to switch tab: ${tabResult.error}`);
      return;
    }
    await sleep(500);
  }

  const result = await deps.commandExecutor.sendMessage(commandId, text);
  if (!result.ok) await ctx.reply(`⚠️ Failed to send: ${result.error}`);
}
