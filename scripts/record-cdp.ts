import 'dotenv/config';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { CdpClient } from '../src/server/cdp-client.js';
import { extractionFunction } from '../src/server/dom-extractor.js';
import { loadConfig, loadSelectors } from '../src/server/config.js';
import { extractWorkspaceName } from '../src/server/cdp-bridge.js';
import { applyDerivedActivityToState } from '../src/server/activity-derive.js';
import type { CursorState, SelectorConfig } from '../src/server/types.js';

const POLL_MS = 300;
const RECORDING_SCHEMA_VERSION = 2;

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface RecordingHeader {
  schemaVersion: number;
  appVersion: string;
  selectorsHash: string;
  startedAt: string;
}

async function discoverTargets(cdpUrl: string): Promise<CDPTarget[]> {
  const resp = await fetch(`${cdpUrl}/json`, { signal: AbortSignal.timeout(5000) });
  return resp.json() as Promise<CDPTarget[]>;
}

function buildSelectorArgs(sel: SelectorConfig) {
  return [
    sel.chatContainer.strategies,
    sel.approveButton.strategies,
    sel.approveButton.textMatch ?? [],
    sel.rejectButton.strategies,
    sel.rejectButton.textMatch ?? [],
    sel.chatInput.strategies,
    sel.agentStatus.strategies,
    sel.chatTabList?.strategies ?? [],
    sel.modeDropdown?.strategies ?? [],
    sel.modelDropdown?.strategies ?? [],
  ] as const;
}

function getAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch { return 'unknown'; }
}

function hashSelectors(sel: SelectorConfig): string {
  return createHash('md5').update(JSON.stringify(sel)).digest('hex').substring(0, 12);
}

function normalizeVolatileIds(state: CursorState): CursorState {
  let seqApproval = 0;
  const approvals = state.pendingApprovals.map(a => ({
    ...a,
    id: a.id.replace(/approval-\d+/, () => `approval-${seqApproval++}`),
  }));
  return { ...state, pendingApprovals: approvals };
}

async function main() {
  const args = process.argv.slice(2);
  const windowFilter = args.find((_, i, a) => a[i - 1] === '--window') ?? '';

  const config = loadConfig();
  const selectors = loadSelectors(config);
  const cdpUrl = config.cdpUrl;

  console.log(`[record] Discovering targets at ${cdpUrl}...`);
  const targets = await discoverTargets(cdpUrl);
  const pages = targets.filter(t => t.type === 'page' && t.url.includes('workbench'));

  if (pages.length === 0) {
    console.error('[record] No Cursor windows found');
    process.exit(1);
  }

  console.log(`[record] Found ${pages.length} window(s):`);
  for (const p of pages) console.log(`  "${p.title}"`);

  let target = pages[0];
  if (windowFilter) {
    const match = pages.find(p => p.title.toLowerCase().includes(windowFilter.toLowerCase()));
    if (match) {
      target = match;
    } else {
      console.warn(`[record] No window matching "${windowFilter}", using first`);
    }
  }

  if (!target.webSocketDebuggerUrl) {
    console.error(`[record] Target has no WebSocket URL (already debugged?)`);
    process.exit(1);
  }

  console.log(`[record] Connecting to "${target.title}"...`);
  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl);

  const workspace = await extractWorkspaceName(client, config.windowTitleQualifier);
  const windowTitle = workspace ?? target.title;
  console.log(`[record] Connected — workspace: "${windowTitle}"`);

  mkdirSync('data', { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outPath = `data/recording-${ts}.jsonl`;

  const header: RecordingHeader = {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    appVersion: getAppVersion(),
    selectorsHash: hashSelectors(selectors),
    startedAt: new Date().toISOString(),
  };
  writeFileSync(outPath, JSON.stringify({ header }) + '\n');

  console.log(`[record] Writing to ${outPath} (schema v${RECORDING_SCHEMA_VERSION})`);
  console.log(`[record] Polling every ${POLL_MS}ms — press Ctrl+C to stop\n`);

  const selectorArgs = buildSelectorArgs(selectors);
  let lastSig = '';
  let linesWritten = 0;
  let pollCount = 0;
  const startTime = Date.now();
  let running = true;

  process.on('SIGINT', () => { running = false; });

  while (running) {
    pollCount++;
    try {
      const rawState = await Promise.race([
        client.callFunction(
          extractionFunction as (...a: never[]) => unknown,
          ...selectorArgs,
          windowTitle
        ),
        new Promise<null>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]) as CursorState | null;

      const derivedState = rawState ? normalizeVolatileIds(applyDerivedActivityToState(rawState)) : null;

      const sig = JSON.stringify(derivedState);
      if (sig !== lastSig) {
        lastSig = sig;
        const line = JSON.stringify({
          ts: Date.now(),
          state: derivedState,
          raw: rawState,
        }) + '\n';
        appendFileSync(outPath, line);
        linesWritten++;

        const status = derivedState?.agentStatus ?? 'null';
        const msgs = derivedState?.messages.length ?? 0;
        const activity = derivedState?.agentActivityText ?? '';
        const live = derivedState?.agentActivityLive ? ' LIVE' : '';
        process.stdout.write(
          `\r[record] polls=${pollCount} written=${linesWritten} status=${status} msgs=${msgs}${activity ? ` activity="${activity}"${live}` : ''}`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('WebSocket closed') || msg.includes('not connected')) {
        console.error(`\n[record] CDP disconnected: ${msg}`);
        break;
      }
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  client.disconnect();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n[record] Done — ${linesWritten} snapshots in ${elapsed}s -> ${outPath}`);
}

main().catch(err => {
  console.error('[record] Fatal:', err);
  process.exit(1);
});
