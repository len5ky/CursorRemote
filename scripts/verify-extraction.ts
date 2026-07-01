import { readFileSync } from 'node:fs';
import { CdpClient } from '../src/server/cdp-client.js';
import { extractionFunction } from '../src/server/dom-extractor.js';
import type { SelectorConfig } from '../src/server/types.js';

async function main() {
  const selectors = JSON.parse(readFileSync('selectors.json', 'utf8')) as SelectorConfig;
  const resp = await fetch('http://127.0.0.1:9222/json');
  const pages = (await resp.json() as Array<{ type: string; title: string; url: string; webSocketDebuggerUrl?: string }>)
    .filter(t => t.type === 'page' && t.url.includes('workbench'));
  const target = pages.find(p => p.title.includes('shopi.world')) || pages[0];
  if (!target?.webSocketDebuggerUrl) throw new Error('No CDP target');

  const client = new CdpClient();
  await client.connect(target.webSocketDebuggerUrl);

  const state = await client.callFunction(
    extractionFunction,
    selectors.chatContainer.strategies,
    selectors.approveButton.strategies,
    selectors.approveButton.textMatch,
    selectors.rejectButton.strategies,
    selectors.rejectButton.textMatch,
    selectors.chatInput.strategies,
    selectors.agentStatus.strategies,
    selectors.chatTabList.strategies,
    selectors.modeDropdown.strategies,
    selectors.modelDropdown.strategies,
    target.title,
  );

  if (!state) {
    console.error('extraction returned null');
    process.exit(1);
  }

  console.log('messages:', state.messages.length);
  console.log('types:', state.messages.map(m => m.type).join(', '));
  const assistants = state.messages.filter(m => m.type === 'assistant');
  if (assistants.length > 0) {
    const last = assistants[assistants.length - 1];
    console.log('last assistant:', (last as { text?: string }).text?.slice(0, 200));
  }
  client.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
