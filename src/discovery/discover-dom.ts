import { CdpClient } from '../server/cdp-client.js';

const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9222';

interface DOMSummaryNode {
  tag: string;
  id?: string;
  classes: string[];
  ariaLabel?: string;
  role?: string;
  text?: string;
  childCount: number;
  children?: DOMSummaryNode[];
}

async function main(): Promise<void> {
  console.log('=== Cursor DOM Discovery Tool ===\n');
  console.log(`Connecting to: ${CDP_URL}\n`);

  // 1. List all targets
  console.log('--- CDP Targets ---\n');
  let targets: Array<{ id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string }>;

  try {
    const resp = await fetch(`${CDP_URL}/json`);
    targets = await resp.json() as typeof targets;
  } catch {
    console.error(`Failed to connect to ${CDP_URL}/json`);
    console.error('Make sure Cursor is running with --remote-debugging-port=9222');
    process.exit(1);
  }

  for (const t of targets) {
    console.log(`  [${t.type}] "${t.title}"`);
    console.log(`    URL: ${t.url}`);
    console.log(`    WS:  ${t.webSocketDebuggerUrl ?? 'N/A'}\n`);
  }

  // 2. Connect to the best target
  const target =
    targets.find(t => t.type === 'page' && t.url.includes('workbench')) ??
    targets.find(t => t.type === 'page') ??
    targets[0];

  if (!target?.webSocketDebuggerUrl) {
    console.error('No suitable target found');
    process.exit(1);
  }

  console.log(`--- Connecting to: "${target.title}" ---\n`);

  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl);

  // 3. Explore the DOM
  console.log('--- DOM Exploration ---\n');

  const domInfo = await client.evaluate(`
    (() => {
      function summarize(el, depth, maxDepth) {
        const node = {
          tag: el.tagName.toLowerCase(),
          classes: Array.from(el.classList),
          childCount: el.children.length,
        };
        if (el.id) node.id = el.id;
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) node.ariaLabel = ariaLabel;
        const role = el.getAttribute('role');
        if (role) node.role = role;
        if (el.children.length === 0 && el.textContent) {
          const text = el.textContent.trim();
          if (text.length > 0 && text.length < 100) node.text = text;
        }
        if (depth < maxDepth) {
          node.children = Array.from(el.children).map(c => summarize(c, depth + 1, maxDepth));
        }
        return node;
      }

      return {
        title: document.title,
        bodyClasses: Array.from(document.body.classList),
        topLevel: Array.from(document.body.children).map(c => summarize(c, 0, 2)),
      };
    })()
  `) as { title: string; bodyClasses: string[]; topLevel: DOMSummaryNode[] };

  console.log(`Page title: ${domInfo.title}`);
  console.log(`Body classes: ${domInfo.bodyClasses.join(', ') || '(none)'}\n`);

  console.log('Top-level elements:\n');
  for (const node of domInfo.topLevel) {
    printNode(node, 0);
  }

  // 4. Search for chat-related elements
  console.log('\n--- Chat Element Search ---\n');

  const chatSearch = await client.evaluate(`
    (() => {
      const patterns = [
        'composer', 'chat', 'agent', 'message', 'conversation',
        'sidebar', 'panel', 'inline-chat', 'copilot',
      ];
      const results = [];

      for (const pattern of patterns) {
        const elements = document.querySelectorAll("[class*='" + pattern + "']");
        for (const el of Array.from(elements).slice(0, 3)) {
          results.push({
            pattern,
            selector: buildSelector(el),
            tag: el.tagName.toLowerCase(),
            classes: Array.from(el.classList).join(' '),
            text: (el.textContent || '').trim().substring(0, 80),
          });
        }
      }

      const buttons = document.querySelectorAll('button');
      const interestingButtons = [];
      const buttonKeywords = ['accept', 'approve', 'reject', 'deny', 'cancel', 'run', 'send'];
      for (const btn of Array.from(buttons)) {
        const label = (btn.textContent?.trim() ?? '') + ' ' + (btn.getAttribute('aria-label') ?? '');
        for (const kw of buttonKeywords) {
          if (label.toLowerCase().includes(kw)) {
            interestingButtons.push({
              pattern: 'button:' + kw,
              selector: buildSelector(btn),
              tag: 'button',
              classes: Array.from(btn.classList).join(' '),
              text: btn.textContent?.trim().substring(0, 50) ?? '',
            });
            break;
          }
        }
      }

      const inputs = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
      const inputResults = [];
      for (const input of Array.from(inputs).slice(0, 5)) {
        inputResults.push({
          pattern: 'input',
          selector: buildSelector(input),
          tag: input.tagName.toLowerCase(),
          classes: Array.from(input.classList).join(' '),
          text: (input.getAttribute('placeholder') ?? input.getAttribute('aria-label') ?? '').substring(0, 50),
        });
      }

      function buildSelector(el) {
        const parts = [];
        let current = el;
        let depth = 0;
        while (current && current !== document.body && depth < 5) {
          let s = current.tagName.toLowerCase();
          if (current.id) { parts.unshift('#' + current.id); break; }
          const cls = Array.from(current.classList).slice(0, 2).join('.');
          if (cls) s += '.' + cls;
          parts.unshift(s);
          current = current.parentElement;
          depth++;
        }
        return parts.join(' > ');
      }

      return { classPatterns: results, buttons: interestingButtons, inputs: inputResults };
    })()
  `) as {
    classPatterns: Array<{ pattern: string; selector: string; tag: string; classes: string; text: string }>;
    buttons: Array<{ pattern: string; selector: string; tag: string; classes: string; text: string }>;
    inputs: Array<{ pattern: string; selector: string; tag: string; classes: string; text: string }>;
  };

  if (chatSearch.classPatterns.length > 0) {
    console.log('Elements matching chat/agent class patterns:\n');
    for (const r of chatSearch.classPatterns) {
      console.log(`  [${r.pattern}] <${r.tag}>`);
      console.log(`    classes: ${r.classes}`);
      console.log(`    selector: ${r.selector}`);
      if (r.text) console.log(`    text: "${r.text.substring(0, 60)}..."`);
      console.log();
    }
  } else {
    console.log('  No elements found matching chat/agent class patterns.\n');
  }

  if (chatSearch.buttons.length > 0) {
    console.log('Interesting buttons (approve/reject/send):\n');
    for (const r of chatSearch.buttons) {
      console.log(`  [${r.pattern}] "${r.text}"`);
      console.log(`    classes: ${r.classes}`);
      console.log(`    selector: ${r.selector}\n`);
    }
  } else {
    console.log('  No approval/action buttons found.\n');
  }

  if (chatSearch.inputs.length > 0) {
    console.log('Text inputs found:\n');
    for (const r of chatSearch.inputs) {
      console.log(`  <${r.tag}> placeholder="${r.text}"`);
      console.log(`    classes: ${r.classes}`);
      console.log(`    selector: ${r.selector}\n`);
    }
  } else {
    console.log('  No text inputs found.\n');
  }

  console.log('--- Discovery Complete ---');
  console.log('\nUse the selectors above to update selectors.json');

  client.disconnect();
}

function printNode(node: DOMSummaryNode, depth: number): void {
  const indent = '  '.repeat(depth);
  const parts = [`<${node.tag}`];
  if (node.id) parts.push(` id="${node.id}"`);
  if (node.role) parts.push(` role="${node.role}"`);
  if (node.ariaLabel) parts.push(` aria-label="${node.ariaLabel}"`);
  parts.push('>');

  const classStr = node.classes.length > 0
    ? ` [${node.classes.slice(0, 3).join(', ')}${node.classes.length > 3 ? '...' : ''}]`
    : '';

  const textStr = node.text ? ` "${node.text.substring(0, 40)}"` : '';
  const childStr = node.childCount > 0 ? ` (${node.childCount} children)` : '';

  console.log(`${indent}${parts.join('')}${classStr}${textStr}${childStr}`);

  if (node.children) {
    for (const child of node.children) {
      printNode(child, depth + 1);
    }
  }
}

main().catch((err) => {
  console.error('Discovery failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
