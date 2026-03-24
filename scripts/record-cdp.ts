import 'dotenv/config';
import { appendFileSync, mkdirSync } from 'fs';
import { CdpClient } from '../src/server/cdp-client.js';
import { extractionFunction } from '../src/server/dom-extractor.js';
import { loadConfig, loadSelectors } from '../src/server/config.js';
import { extractWorkspaceName } from '../src/server/cdp-bridge.js';
import type { CursorState, SelectorConfig } from '../src/server/types.js';

const POLL_MS = 300;

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
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
  console.log(`[record] Writing to ${outPath}`);
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
      const state = await Promise.race([
        client.callFunction(
          extractionFunction as (...a: never[]) => unknown,
          ...selectorArgs,
          windowTitle
        ),
        new Promise<null>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]) as CursorState | null;

      const sig = JSON.stringify(state);
      if (sig !== lastSig) {
        lastSig = sig;
        const line = JSON.stringify({ ts: Date.now(), state }) + '\n';
        appendFileSync(outPath, line);
        linesWritten++;

        const status = state?.agentStatus ?? 'null';
        const msgs = state?.messages.length ?? 0;
        const activity = state?.agentActivityText ?? '';
        process.stdout.write(
          `\r[record] polls=${pollCount} written=${linesWritten} status=${status} msgs=${msgs}${activity ? ` activity="${activity}"` : ''}`
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
