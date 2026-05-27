import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

// Opens the Cursor model picker via the new + legacy trigger selectors,
// then dumps the resulting menu (and its child rows) so we can confirm the
// selectors used inside command-executor.ts still work on the current Cursor.
//
// Usage: npm run discover -- model-picker
// or:    npx tsx scripts/probe-model-picker.ts [--window <substring>]

async function main() {
  const args = process.argv.slice(2);
  const windowFilter = args.find((_, i, a) => a[i - 1] === '--window') ?? '';

  const config = loadConfig();
  const resp = await fetch(`${config.cdpUrl}/json`);
  const targets = await resp.json() as CDPTarget[];
  const pages = targets.filter((t) => t.type === 'page' && t.url.includes('workbench'));
  if (pages.length === 0) {
    console.error('[probe-model-picker] No workbench page targets found at', config.cdpUrl);
    process.exit(2);
  }
  let target = pages[0];
  if (windowFilter) {
    const m = pages.find((p) => p.title.toLowerCase().includes(windowFilter.toLowerCase()));
    if (m) target = m;
  }
  console.log(`[probe-model-picker] Probing "${target.title}"`);

  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl!);

  // Step 1: report which trigger selectors match before opening.
  const triggerReport = await client.evaluate(`
    (() => {
      const out = {};
      for (const sel of ['.ui-model-picker__trigger', '.composer-unified-dropdown-model']) {
        const els = document.querySelectorAll(sel);
        out[sel] = {
          count: els.length,
          first: els[0] ? (els[0].outerHTML || '').slice(0, 400) : null,
          ariaControls: els[0] ? els[0].getAttribute('aria-controls') : null,
          ariaExpanded: els[0] ? els[0].getAttribute('aria-expanded') : null,
        };
      }
      return out;
    })()
  `) as Record<string, { count: number; first: string | null; ariaControls: string | null; ariaExpanded: string | null }>;
  console.log('\n--- Trigger selectors (before click) ---');
  console.log(JSON.stringify(triggerReport, null, 2));

  // Step 2: click the first matching trigger.
  const clicked = await client.evaluate(`
    (() => {
      for (const sel of ['.ui-model-picker__trigger', '.composer-unified-dropdown-model']) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return sel; }
      }
      return null;
    })()
  `) as string | null;
  console.log(`\nClicked: ${clicked ?? 'NOTHING (no trigger matched)'}`);
  if (!clicked) {
    process.exit(3);
  }

  await new Promise((r) => setTimeout(r, 400));

  // Step 3: report what the menu looks like now.
  const menuReport = await client.evaluate(`
    (() => {
      const out = {};
      out.byTestId = !!document.querySelector('[data-testid="model-picker-menu"]');
      const trigger = document.querySelector(
        '.ui-model-picker__trigger[aria-expanded="true"],.composer-unified-dropdown-model[aria-expanded="true"]'
      );
      out.ariaControls = trigger ? trigger.getAttribute('aria-controls') : null;
      out.menuByControls = (() => {
        if (!out.ariaControls) return null;
        const el = document.getElementById(out.ariaControls);
        return el ? { tag: el.tagName, role: el.getAttribute('role'), childCount: el.children.length, outer: (el.outerHTML || '').slice(0, 600) } : null;
      })();
      const openMenu = document.querySelector('[role="menu"][data-state="open"]')
        || document.querySelector('[role="menu"]:not([hidden])');
      out.firstOpenMenu = openMenu ? {
        tag: openMenu.tagName,
        role: openMenu.getAttribute('role'),
        dataState: openMenu.getAttribute('data-state'),
        childCount: openMenu.children.length,
      } : null;
      const itemsSel = '[id], [role="menuitem"], button, [data-testid]';
      const items = openMenu ? Array.from(openMenu.querySelectorAll(itemsSel)) : [];
      out.itemSample = items.slice(0, 12).map((it) => ({
        tag: it.tagName,
        id: it.id || '',
        role: it.getAttribute('role'),
        testid: it.getAttribute('data-testid'),
        text: (it.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      }));
      return out;
    })()
  `);
  console.log('\n--- Menu after click ---');
  console.log(JSON.stringify(menuReport, null, 2));

  // Step 4: close the menu.
  await client.pressKey('Escape', 'Escape', 27);

  await client.disconnect();
  console.log('\n[probe-model-picker] done. Paste this report into issue #22 to confirm the fix.');
}

main().catch((err) => {
  console.error('[probe-model-picker]', err);
  process.exit(1);
});
