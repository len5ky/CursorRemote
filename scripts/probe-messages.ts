import { CdpClient } from '../src/server/cdp-client.js';

async function main() {
  const resp = await fetch('http://127.0.0.1:9222/json');
  const pages = (await resp.json() as Array<{ type: string; title: string; url: string; webSocketDebuggerUrl?: string }>)
    .filter(t => t.type === 'page' && t.url.includes('workbench'));

  for (const p of pages) console.log('PAGE:', p.title);

  const target = pages.find(p => p.title.includes('shopi.world')) || pages[0];
  if (!target?.webSocketDebuggerUrl) {
    console.error('No CDP target');
    process.exit(1);
  }

  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl);

  const r = await client.callFunction(() => {
    const aux = document.querySelector('#workbench\\.parts\\.auxiliarybar');
    const doc = document;
    const count = (root: ParentNode, sel: string) => root.querySelectorAll(sel).length;

    const samples: Array<Record<string, string | null>> = [];
    const searchRoot = aux || doc;
    for (const el of Array.from(searchRoot.querySelectorAll(
      '[data-flat-index], [data-message-role], .aislash-editor-input-readonly, .aislash-editor-input, [data-tab0-role]'
    )).slice(0, 20)) {
      samples.push({
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 100),
        flat: el.getAttribute('data-flat-index'),
        role: el.getAttribute('data-message-role') || el.getAttribute('data-tab0-role'),
        kind: el.getAttribute('data-message-kind') || el.getAttribute('data-tab0-kind'),
        text: (el.textContent || '').trim().slice(0, 120),
      });
    }

    const attrHits: Record<string, number> = {};
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      for (const a of Array.from(el.attributes)) {
        if (/message|flat|composer|tab0|aislash/i.test(a.name)) {
          attrHits[a.name] = (attrHits[a.name] || 0) + 1;
        }
      }
    }

    // Find chat scroll/list containers
    const listCandidates: Array<{ sel: string; count: number; sampleCls: string }> = [];
    const candidateSels = [
      '[class*="composer-messages"]',
      '[class*="message-list"]',
      '[class*="chat-messages"]',
      '[class*="conversation"]',
      '.composer-bar',
      '[data-composer-id]',
      '.aislash-scroll',
      '[class*="aislash"]',
    ];
    for (const sel of candidateSels) {
      try {
        const els = doc.querySelectorAll(sel);
        if (els.length > 0) {
          listCandidates.push({
            sel,
            count: els.length,
            sampleCls: String((els[0] as Element).className || '').slice(0, 100),
          });
        }
      } catch { /* skip */ }
    }

    return {
      windowTitle: document.title,
      auxBar: !!aux,
      auxHTML: aux ? (aux as HTMLElement).innerHTML.slice(0, 500) : null,
      inAux: {
        flatIndex: count(aux || doc, '[data-flat-index]'),
        messageRole: count(aux || doc, '[data-message-role]'),
        tab0Role: count(aux || doc, '[data-tab0-role]'),
        aislashReadonly: count(aux || doc, '.aislash-editor-input-readonly'),
        aislashInput: count(aux || doc, '.aislash-editor-input'),
        composerBar: count(aux || doc, '.composer-bar'),
        markdown: count(aux || doc, '.markdown-root'),
      },
      inDoc: {
        flatIndex: count(doc, '[data-flat-index]'),
        messageRole: count(doc, '[data-message-role]'),
        tab0Role: count(doc, '[data-tab0-role]'),
      },
      samples,
      listCandidates,
      topAttrs: Object.entries(attrHits).sort((a, b) => b[1] - a[1]).slice(0, 25),
    };
  }) as Record<string, unknown>;

  console.log(JSON.stringify(r, null, 2));
  client.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
