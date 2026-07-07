import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  CommandExecutor,
  resolveActionClickTarget,
  type ActionClickTargetResult,
} from '../src/server/command-executor.js';
import type { CdpClient } from '../src/server/cdp-client.js';
import type { SelectorConfig } from '../src/server/types.js';

function documentFor(html: string): Document {
  return new JSDOM(html).window.document;
}

function assertElement(result: ActionClickTargetResult): Element {
  assert.ok('element' in result, 'expected resolver to return an element');
  return result.element;
}

function assertError(result: ActionClickTargetResult): string {
  assert.ok('error' in result, 'expected resolver to return an error');
  return result.error;
}

describe('action click target resolution', () => {
  it('returns the selector target when its label matches', () => {
    const document = documentFor(`
      <main id="toolbar">
        <button id="continue">Continue</button>
      </main>
    `);

    const result = resolveActionClickTarget(document, '#continue', 'continue');

    assert.equal(assertElement(result).id, 'continue');
  });

  it('falls back to exactly one scoped text match when the selector label mismatches', () => {
    const document = documentFor(`
      <main id="toolbar">
        <button id="stale">Not Continue</button>
        <button id="target" class="ui-button ui-9f619">Continue</button>
      </main>
      <button id="outside">Continue</button>
    `);

    const result = resolveActionClickTarget(
      document,
      '#toolbar > button#stale',
      'Continue'
    );

    assert.equal(assertElement(result).id, 'target');
  });

  it('does not choose a target when scoped text matches are missing or ambiguous', () => {
    const zeroDocument = documentFor(`
      <main id="toolbar">
        <button id="stale">Not Continue</button>
      </main>
    `);
    const zero = resolveActionClickTarget(zeroDocument, '#toolbar > button#stale', 'Continue');

    assert.match(assertError(zero), /action target not found \(label: Continue\)/);

    const multipleDocument = documentFor(`
      <main id="toolbar">
        <button id="stale">Not Continue</button>
        <button id="one">Continue</button>
        <button id="two" role="button">Continue</button>
      </main>
    `);
    const multiple = resolveActionClickTarget(multipleDocument, '#toolbar > button#stale', 'Continue');

    assert.match(assertError(multiple), /action target not found \(label: Continue\)/);
  });

  it('returns a closest button ancestor or descendant button when that label matches', () => {
    const ancestorDocument = documentFor(`
      <button id="ancestor" class="ui-button">
        <span id="inner">Continue</span>
      </button>
    `);
    const ancestor = resolveActionClickTarget(ancestorDocument, '#inner', 'Continue');

    assert.equal(assertElement(ancestor).id, 'ancestor');

    const descendantDocument = documentFor(`
      <section id="container">
        <button id="descendant" class="ui-button">Continue</button>
      </section>
    `);
    const descendant = resolveActionClickTarget(descendantDocument, '#container', 'Continue');

    assert.equal(assertElement(descendant).id, 'descendant');
  });

  it('keeps clickAction legacy behavior when no expected label is provided', async () => {
    const clickedSelectors: string[] = [];
    let evaluateCalled = false;
    const fakeClient = {
      isConnected: () => true,
      click: async (selector: string) => {
        clickedSelectors.push(selector);
      },
      evaluate: async () => {
        evaluateCalled = true;
        return null;
      },
    } as unknown as CdpClient;
    const executor = new CommandExecutor({} as SelectorConfig);
    executor.setClient(fakeClient);

    const result = await executor.clickAction('cmd-1', '#legacy-button');

    assert.equal(result.ok, true);
    assert.deepEqual(clickedSelectors, ['#legacy-button']);
    assert.equal(evaluateCalled, false);
  });
});
