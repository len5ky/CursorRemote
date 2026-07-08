import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractionFunction } from '../src/server/dom-extractor.js';
import type { CursorState } from '../src/server/types.js';

function withDom(html: string): CursorState {
  const dom = new JSDOM(html);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nodeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: dom.window.Node,
  });
  try {
    const state = extractionFunction(
      ['#root'],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      []
    );
    assert.ok(state, 'expected extractionFunction to return state');
    return state;
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    } else {
      delete globalThis.document;
    }
    if (nodeDescriptor) {
      Object.defineProperty(globalThis, 'Node', nodeDescriptor);
    } else {
      delete globalThis.Node;
    }
  }
}

describe('extractionFunction', () => {
  it('emits Cursor 3.8 activity tool-placeholder rows without data-message-role', () => {
    const state = withDom(`
      <main id="root">
        <div data-find-row-key="tool-placeholder:call-1">
          <article data-flat-index="0" data-react-transcript-row-kind="activity" data-message-id="m-tool">
            <div data-tool-call-id="call-1" data-tool-status="completed">
              <span class="ui-tool-call-line-action">Read</span>
              <span class="ui-tool-call-line-details">src/server/dom-extractor.ts</span>
            </div>
          </article>
        </div>
      </main>
    `);

    const tool = state.messages.find((message) => message.type === 'tool');

    assert.ok(tool, 'expected a tool element to be emitted');
    assert.equal(tool.toolCallId, 'call-1');
    assert.equal(tool.action, 'Read');
  });

  it('uses anchored selector paths for data-click-ready questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
          <section class="composer-questionnaire-toolbar-actions">
            <div data-click-ready="true">
              <span><span class="truncate">Skip</span></span>
            </div>
            <div class="shortcut">Esc</div>
            <div data-click-ready="true" data-disabled="true">
              <span><span class="truncate">Continue</span></span>
            </div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(1)'
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(3)'
    );
    assert.equal(state.questionnaire.continueDisabled, true);
  });

  it('keeps buildSelectorPath selectors for legacy questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <section class="composer-questionnaire-toolbar-actions">
            <div class="composer-skip-button">Skip</div>
            <div class="composer-run-button" data-disabled="false">Continue</div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(1)'
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(2)'
    );
    assert.equal(state.questionnaire.continueDisabled, false);
  });
});
