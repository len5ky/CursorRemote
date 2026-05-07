import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const windowFilter = args.find((_, i, a) => a[i - 1] === '--window') ?? '';

  const config = loadConfig();
  const resp = await fetch(`${config.cdpUrl}/json`);
  const targets = await resp.json() as CDPTarget[];
  const pages = targets.filter((t) => t.type === 'page' && t.url.includes('workbench'));

  let target = pages[0];
  if (windowFilter) {
    const m = pages.find((p) => p.title.toLowerCase().includes(windowFilter.toLowerCase()));
    if (m) target = m;
  }
  console.log(`[probe-glass] Probing "${target.title}"`);

  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl!);

  const result = await client.callFunction(() => {
    const out: Record<string, unknown> = {};

    // Test the exact selectors PR #14 uses
    const glassContainer = document.querySelectorAll('.glass-sidebar-agent-list-container');
    out.glassContainerCount = glassContainer.length;

    const glassMenuItems = document.querySelectorAll('.glass-sidebar-agent-list-container li.ui-sidebar-menu-item');
    out.glassMenuItemCount = glassMenuItems.length;

    const glassMenuBtns = document.querySelectorAll(
      '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn'
    );
    out.glassMenuBtnCount = glassMenuBtns.length;

    // Inspect each
    const samples: Record<string, unknown>[] = [];
    for (const btn of Array.from(glassMenuBtns).slice(0, 12)) {
      const labelEl = btn.querySelector('.ui-sidebar-menu-button-label');
      const group = btn.closest('.ui-sidebar-group');
      const groupLabel = group?.querySelector('.ui-sidebar-group-label-title');
      const composerId = btn.getAttribute('data-composer-id')
        || btn.closest('[data-composer-id]')?.getAttribute('data-composer-id')
        || null;
      const dataActive = btn.getAttribute('data-active');
      const ariaSelected = btn.getAttribute('aria-selected');
      const classes = btn.className;
      samples.push({
        label: (labelEl?.textContent || '').trim().substring(0, 80),
        group: (groupLabel?.textContent || '').trim().substring(0, 60),
        composerId,
        dataActive,
        ariaSelected,
        classes: classes.substring(0, 200),
      });
    }
    out.samples = samples;

    // Probe alternative naming patterns Cursor might be using now
    const altSelectors = [
      '[class*="glass-sidebar"]',
      '[class*="agent-list"]',
      '[class*="sidebar-agent"]',
      'li[class*="ui-sidebar-menu-item"]',
      '[class*="glass-sidebar-agent-menu-btn"]',
      '[class*="ui-sidebar-menu-button-label"]',
      '[class*="ui-sidebar-group"]',
    ];
    const altCounts: Record<string, number> = {};
    for (const sel of altSelectors) {
      try {
        altCounts[sel] = document.querySelectorAll(sel).length;
      } catch {
        altCounts[sel] = -1;
      }
    }
    out.altCounts = altCounts;

    // Check for the legacy selector too
    out.legacyAgentSidebarCells = document.querySelectorAll('.agent-sidebar-cell').length;

    return out;
  }) as Record<string, unknown>;

  console.log(JSON.stringify(result, null, 2));
  client.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
