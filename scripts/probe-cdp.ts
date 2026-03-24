import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';

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

async function main() {
  const args = process.argv.slice(2);
  const windowFilter = args.find((_, i, a) => a[i - 1] === '--window') ?? '';

  const config = loadConfig();
  const cdpUrl = config.cdpUrl;

  console.log(`[probe] Discovering targets at ${cdpUrl}...`);
  const targets = await discoverTargets(cdpUrl);
  const pages = targets.filter(t => t.type === 'page' && t.url.includes('workbench'));

  if (pages.length === 0) {
    console.error('[probe] No Cursor windows found');
    process.exit(1);
  }

  console.log(`[probe] Found ${pages.length} window(s):`);
  for (const p of pages) console.log(`  "${p.title}"`);

  let target = pages[0];
  if (windowFilter) {
    const match = pages.find(p => p.title.toLowerCase().includes(windowFilter.toLowerCase()));
    if (match) target = match;
    else console.warn(`[probe] No window matching "${windowFilter}", using first`);
  }
  if (!target.webSocketDebuggerUrl) {
    console.error('[probe] Target has no WebSocket URL');
    process.exit(1);
  }

  console.log(`[probe] Connecting to "${target.title}"...\n`);

  const { CdpClient } = await import('../src/server/cdp-client.js');
  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl);

  const result = await client.callFunction(() => {
    const container = document.querySelector('#workbench\\.parts\\.auxiliarybar') || document.body;

    const out: Record<string, unknown>[] = [];

    // All .make-shine elements
    const shineEls = container.querySelectorAll('.make-shine');
    for (const el of Array.from(shineEls)) {
      const wrapper = el.closest('[data-flat-index]');
      const toolCall = el.closest('[data-tool-call-id]');
      const header = el.closest('.ui-collapsible-header');
      const loadingInd = el.closest('.loading-indicator-v3') || wrapper?.querySelector('.loading-indicator-v3');
      out.push({
        type: 'make-shine',
        text: (el.textContent || '').trim().substring(0, 200),
        parentText: (el.parentElement?.textContent || '').trim().substring(0, 200),
        wrapperFlatIndex: wrapper?.getAttribute('data-flat-index'),
        insideToolCall: !!toolCall,
        toolCallId: toolCall?.getAttribute('data-tool-call-id'),
        insideHeader: !!header,
        hasLoadingIndicator: !!loadingInd,
        classes: el.className,
        parentClasses: el.parentElement?.className || '',
      });
    }

    // Loading indicators
    const loadingEls = container.querySelectorAll('.loading-indicator-v3');
    for (const el of Array.from(loadingEls)) {
      const wrapper = el.closest('[data-flat-index]');
      out.push({
        type: 'loading-indicator',
        text: (el.textContent || '').trim().substring(0, 200),
        wrapperText: (wrapper?.textContent || '').trim().substring(0, 200),
        wrapperFlatIndex: wrapper?.getAttribute('data-flat-index'),
        classes: el.className,
        wrapperClasses: wrapper?.className || '',
      });
    }

    // Inner thinking steps (nested under step-group content)
    const thinkingCollapsibles = container.querySelectorAll('.ui-collapsible.ui-thinking-collapsible');
    for (const tc of Array.from(thinkingCollapsibles).slice(0, 15)) {
      const hdr = tc.querySelector('.ui-collapsible-header');
      const wrapper = tc.closest('[data-flat-index]');
      out.push({
        type: 'ui-thinking-collapsible',
        headerText: (hdr?.textContent || '').replace(/\s+/g, ' ').trim().substring(0, 200),
        hasMakeShine: !!tc.querySelector('.make-shine') || !!hdr?.querySelector('.make-shine'),
        wrapperFlatIndex: wrapper?.getAttribute('data-flat-index'),
        dataOpen: tc.getAttribute('data-open'),
        dataExpandable: tc.getAttribute('data-expandable'),
      });
    }

    // Thought block headers (step-group collapsibles) — look for animated/shimmer elements
    const stepGroups = container.querySelectorAll('.ui-collapsible.ui-step-group-collapsible');
    for (const sg of Array.from(stepGroups)) {
      const header = sg.querySelector('.ui-collapsible-header');
      if (!header) continue;
      const wrapper = sg.closest('[data-flat-index]');
      const allChildren = header.querySelectorAll('*');
      const animatedClasses: string[] = [];
      for (const child of Array.from(allChildren)) {
        const cls = child.className;
        if (typeof cls === 'string' && cls.length > 0) {
          animatedClasses.push(cls.substring(0, 150));
        }
      }
      const hEl = header as HTMLElement;
      const computed = window.getComputedStyle(hEl);
      out.push({
        type: 'step-group-header',
        text: (header.textContent || '').trim().substring(0, 200),
        headerClasses: hEl.className,
        wrapperFlatIndex: wrapper?.getAttribute('data-flat-index'),
        childClasses: animatedClasses.slice(0, 20),
        animation: computed.animation || computed.getPropertyValue('animation'),
        transition: computed.transition,
        background: computed.backgroundImage?.substring(0, 200),
        headerHTML: hEl.innerHTML.substring(0, 500),
      });
    }

    // Last [data-flat-index] element — often the most interesting (tail of chat)
    const allFlatIdx = container.querySelectorAll('[data-flat-index]');
    if (allFlatIdx.length > 0) {
      const lastWrapper = allFlatIdx[allFlatIdx.length - 1] as HTMLElement;
      const fi = lastWrapper.getAttribute('data-flat-index');
      const role = lastWrapper.getAttribute('data-tab0-role');
      const kind = lastWrapper.getAttribute('data-tab0-kind');
      const stepGroup = lastWrapper.querySelector('.ui-collapsible.ui-step-group-collapsible');
      const stepHeader = stepGroup?.querySelector('.ui-collapsible-header') as HTMLElement | null;
      out.push({
        type: 'last-flat-index',
        flatIndex: fi,
        role, kind,
        hasStepGroup: !!stepGroup,
        headerText: stepHeader?.textContent?.trim().substring(0, 200) || null,
        headerHTML: stepHeader?.innerHTML?.substring(0, 600) || null,
        wrapperClasses: lastWrapper.className.substring(0, 200),
        textPreview: (lastWrapper.textContent || '').trim().substring(0, 200),
      });
    }

    // Broad search: any element with shimmer/shine/animate in class name
    const shimmerPatterns = [
      '[class*="shimmer"]', '[class*="shine"]', '[class*="pulse"]',
      '[class*="skeleton"]', '[class*="glow"]', '[class*="blink"]',
      '[class*="animate"]', '[class*="loading-text"]',
    ];
    for (const sel of shimmerPatterns) {
      try {
        const els = container.querySelectorAll(sel);
        for (const el of Array.from(els).slice(0, 5)) {
          const wrapper = el.closest('[data-flat-index]');
          out.push({
            type: 'shimmer-pattern',
            selector: sel,
            text: (el.textContent || '').trim().substring(0, 100),
            classes: el.className.substring(0, 200),
            wrapperFlatIndex: wrapper?.getAttribute('data-flat-index'),
            tag: el.tagName,
          });
        }
      } catch { /* ignore */ }
    }

    // Status description
    const statusDesc = container.querySelector('.composer-terminal-top-header-description');
    if (statusDesc) {
      out.push({
        type: 'status-desc',
        text: (statusDesc.textContent || '').trim().substring(0, 200),
        classes: statusDesc.className,
      });
    }

    // Agent status selectors
    const statusSelectors = [
      'span.auxiliary-bar-chat-title',
      '[class*="auxiliary-bar-chat-title"]',
      '[class*="status"]',
      '[class*="thinking"]',
      '[class*="spinner"]',
    ];
    for (const sel of statusSelectors) {
      try {
        const el = container.querySelector(sel);
        if (el) {
          out.push({
            type: 'status-selector',
            selector: sel,
            text: (el.textContent || '').trim().substring(0, 100),
            classes: el.className,
          });
        }
      } catch { /* ignore */ }
    }

    return out;
  }) as Record<string, unknown>[];

  if (!result || result.length === 0) {
    console.log('[probe] No relevant elements found in the DOM');
  } else {
    console.log(`[probe] Found ${result.length} elements:\n`);
    for (const item of result) {
      console.log(`--- ${item.type} ---`);
      for (const [k, v] of Object.entries(item)) {
        if (k === 'type') continue;
        if (v === '' || v === undefined || v === null || v === false) continue;
        console.log(`  ${k}: ${typeof v === 'string' ? `"${v}"` : v}`);
      }
      console.log();
    }
  }

  client.disconnect();
}

main().catch(err => {
  console.error('[probe] Fatal:', err.message || err);
  process.exit(1);
});
