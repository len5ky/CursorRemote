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
  console.log(`[probe-tabs] Probing "${target.title}"`);

  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl!);

  const result = await client.callFunction(() => {
    const dump = (el: Element) => {
      const attrs: Record<string, string> = {};
      for (const a of Array.from(el.attributes)) {
        if (a.name.startsWith('data-') || a.name.startsWith('aria-') || a.name === 'role' || a.name === 'class' || a.name === 'tabindex') {
          attrs[a.name] = a.value.substring(0, 120);
        }
      }
      const titleEl =
        el.querySelector('.agent-sidebar-cell-text') ||
        el.querySelector('.ui-sidebar-menu-button-label') ||
        el.querySelector('[class*="title"]') ||
        el.querySelector('[class*="label"]');
      return {
        tag: el.tagName,
        title: (titleEl?.textContent || '').trim().substring(0, 80),
        text: (el.textContent || '').trim().substring(0, 80),
        attrs,
      };
    };

    const findSelectors = [
      '.agent-sidebar-cell',
      '.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn',
      'li.ui-sidebar-menu-item',
      '[data-composer-id]',
      '[data-tab-active]',
      '[role="tab"]',
      'button[aria-selected]',
      '[class*="tab-active"]',
      '[class*="active-tab"]',
      '.composer-tab',
    ];

    const out: { selector: string; count: number; samples: ReturnType<typeof dump>[] }[] = [];
    for (const sel of findSelectors) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          const samples: ReturnType<typeof dump>[] = [];
          for (const el of Array.from(els).slice(0, 8)) samples.push(dump(el));
          out.push({ selector: sel, count: els.length, samples });
        }
      } catch { /* ignore */ }
    }

    // Heuristic: any element with class containing 'active' or 'selected' near the top
    const activeAny = document.querySelectorAll('[class*="active"], [aria-selected="true"], [data-selected="true"], [data-active="true"], [data-highlighted="true"]');
    const activeSamples: ReturnType<typeof dump>[] = [];
    for (const el of Array.from(activeAny).slice(0, 25)) activeSamples.push(dump(el));
    out.push({ selector: '[active-ish]', count: activeAny.length, samples: activeSamples });

    // What's the current chat title in window header? composer top header?
    const composerHeader =
      document.querySelector('.auxiliary-bar-chat-title') ||
      document.querySelector('[class*="composer-header"]') ||
      document.querySelector('[class*="chat-title"]');
    if (composerHeader) {
      out.push({ selector: 'composer-header', count: 1, samples: [dump(composerHeader)] });
    }

    // Title bar — Cursor's window title shows "ChatTab — Project — Cursor"
    out.push({ selector: 'document.title', count: 1, samples: [{ tag: 'TITLE', title: '', text: document.title.substring(0, 200), attrs: {} }] });

    // Scan for any element whose text contains the current window title's prefix
    const titlePrefix = (document.title.split('—')[0] ?? '').trim();
    if (titlePrefix.length > 5) {
      const matchingByText: ReturnType<typeof dump>[] = [];
      const all = document.querySelectorAll('button, li, div[class*="cell"], div[class*="agent"]');
      for (const el of Array.from(all)) {
        const t = (el.textContent || '').trim();
        if (t.startsWith(titlePrefix)) {
          matchingByText.push(dump(el));
          if (matchingByText.length >= 5) break;
        }
      }
      if (matchingByText.length > 0) {
        out.push({ selector: `text-startswith:"${titlePrefix.substring(0, 40)}"`, count: matchingByText.length, samples: matchingByText });
      }
    }

    return out;
  }) as { selector: string; count: number; samples: { tag: string; title: string; text: string; attrs: Record<string, string> }[] }[];

  console.log('');
  for (const r of result) {
    console.log(`--- selector="${r.selector}" count=${r.count} ---`);
    for (const s of r.samples) {
      console.log(`  <${s.tag}> title="${s.title}" text="${s.text}"`);
      for (const [k, v] of Object.entries(s.attrs)) {
        console.log(`     ${k}: "${v}"`);
      }
    }
    console.log('');
  }

  client.disconnect();
}

main().catch((err) => {
  console.error('[probe-tabs] Fatal:', err.message || err);
  process.exit(1);
});
