import { writeFileSync } from 'fs';
import { CdpClient } from '../server/cdp-client.js';

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';
const POLL_MS = 500;
const MAX_RUNTIME_MS = 120_000;

interface Snapshot {
  ts: number;
  wrappers: WrapperInfo[];
}

interface WrapperInfo {
  flatIndex: number;
  hasLoading: boolean;
  hasStepGroup: boolean;
  hasThinkingCollapsible: boolean;
  hasGroupLoading: boolean;
  hasShimmer: boolean;
  headerText: string;
  previewText: string;
  outerHtml: string;
}

async function main(): Promise<void> {
  console.log('=== Thinking DOM Capture ===');
  console.log(`Connecting to: ${CDP_URL}\n`);

  let targets: Array<{ id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string }>;
  try {
    const resp = await fetch(`${CDP_URL}/json`);
    targets = await resp.json() as typeof targets;
  } catch {
    console.error(`Failed to connect to ${CDP_URL}/json`);
    process.exit(1);
  }

  const titleMatch = process.env.CAPTURE_WINDOW ?? 'cursor-ide-remote';
  const pages = targets.filter(t => t.type === 'page' && t.url.includes('workbench'));
  const target =
    pages.find(t => t.title.toLowerCase().includes(titleMatch.toLowerCase())) ??
    pages[0] ??
    targets.find(t => t.type === 'page') ??
    targets[0];

  if (!target?.webSocketDebuggerUrl) {
    console.error('No suitable target found');
    process.exit(1);
  }

  console.log(`Connected to: "${target.title}"\n`);
  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl);

  const snapshots: Snapshot[] = [];
  const start = Date.now();
  let captures = 0;

  console.log(`Polling every ${POLL_MS}ms for up to ${MAX_RUNTIME_MS / 1000}s...`);
  console.log('Waiting for loading/thinking elements...\n');

  while (Date.now() - start < MAX_RUNTIME_MS) {
    try {
      const result = await client.evaluate(`
        (() => {
          const out = [];
          const wrappers = document.querySelectorAll('[data-flat-index]');
          for (const w of wrappers) {
            const hasLoading = !!w.querySelector('.loading-indicator-v3');
            const hasStepGroup = !!w.querySelector('.ui-collapsible.ui-step-group-collapsible');
            const hasThinking = !!w.querySelector('.ui-thinking-collapsible');
            const hasGroupLoading = w.hasAttribute('data-group-loading')
              || !!w.querySelector('[data-group-loading]');
            const hasShimmer = !!w.querySelector('.ui-collapsible-shimmer');

            if (!hasLoading && !hasThinking && !hasGroupLoading && !hasShimmer) continue;

            const header = w.querySelector('.ui-collapsible-header');
            const preview = w.querySelector('.ui-step-group-preview');

            out.push({
              flatIndex: parseInt(w.getAttribute('data-flat-index') || '0', 10),
              hasLoading,
              hasStepGroup,
              hasThinkingCollapsible: hasThinking,
              hasGroupLoading,
              hasShimmer,
              headerText: (header?.textContent || '').trim().substring(0, 200),
              previewText: (preview?.textContent || '').trim().substring(0, 500),
              outerHtml: w.outerHTML.substring(0, 5000),
            });
          }
          return out;
        })()
      `) as WrapperInfo[];

      if (result && result.length > 0) {
        captures++;
        const snap: Snapshot = { ts: Date.now(), wrappers: result };
        snapshots.push(snap);

        for (const w of result) {
          const flags = [
            w.hasLoading ? 'LOADING' : '',
            w.hasStepGroup ? 'STEP_GROUP' : '',
            w.hasThinkingCollapsible ? 'THINKING' : '',
            w.hasGroupLoading ? 'GROUP_LOADING' : '',
            w.hasShimmer ? 'SHIMMER' : '',
          ].filter(Boolean).join('+');
          console.log(`  [${captures}] fi=${w.flatIndex} ${flags} header="${w.headerText.substring(0, 80)}"`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('closed') || msg.includes('WebSocket')) {
        console.error('Connection lost');
        break;
      }
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }

  client.disconnect();

  if (snapshots.length > 0) {
    const outPath = `temp/thinking/capture-${Date.now()}.json`;
    writeFileSync(outPath, JSON.stringify(snapshots, null, 2));
    console.log(`\nSaved ${snapshots.length} snapshots to ${outPath}`);
  } else {
    console.log('\nNo loading/thinking elements captured.');
  }
}

main().catch((err) => {
  console.error('Capture failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
