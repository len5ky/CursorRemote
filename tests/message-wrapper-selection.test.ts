import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { selectMessageWrappers } from '../src/server/dom-extractor.js';

function containerFor(html: string): Element {
  const dom = new JSDOM(`<main id="root">${html}</main>`);
  const root = dom.window.document.getElementById('root');
  assert.ok(root);
  return root;
}

describe('message wrapper selection', () => {
  it('uses legacy data-flat-index wrappers in DOM order', () => {
    const root = containerFor(`
      <div data-flat-index="0"></div>
      <div data-flat-index="1"></div>
      <div data-flat-index="2"></div>
    `);

    const selected = selectMessageWrappers(root);

    assert.equal(selected.length, 3);
    assert.deepEqual(selected.map(item => item.index), [0, 1, 2]);
    assert.deepEqual(selected.map(item => item.element.getAttribute('data-flat-index')), ['0', '1', '2']);
  });

  it('uses data-message-index wrappers when flat index is absent', () => {
    const root = containerFor(`
      <section data-message-index="4"></section>
      <section data-message-index="5"></section>
    `);

    const selected = selectMessageWrappers(root);

    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map(item => item.index), [4, 5]);
  });

  it('includes mixed Cursor 3.8 role/id AI rows alongside indexed human rows', () => {
    const root = containerFor(`
      <section data-message-index="0" data-message-role="human" data-message-kind="human" data-message-id="h1"></section>
      <div class="virtualized-composer-messages-row" data-find-row-key="assistant-markdown:a1">
        <article data-message-role="ai" data-message-id="a1" data-react-transcript-row-kind="assistantMarkdown"></article>
      </div>
    `);

    const selected = selectMessageWrappers(root);

    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map(item => item.index), [0, 1]);
    assert.deepEqual(selected.map(item => item.element.getAttribute('data-message-id')), ['h1', 'a1']);
  });

  it('preserves legacy flat-index wrappers when descendant message nodes also match', () => {
    const root = containerFor(`
      <article data-flat-index="0">
        <div class="composer-rendered-message" data-message-role="human" data-message-kind="human" data-message-id="h1"></div>
      </article>
      <article data-flat-index="1">
        <div class="composer-rendered-message" data-message-role="ai" data-message-kind="assistant" data-message-id="a1"></div>
      </article>
      <article data-flat-index="2">
        <div class="composer-rendered-message" data-message-role="ai" data-message-kind="tool" data-message-id="t1"></div>
      </article>
    `);

    const selected = selectMessageWrappers(root);

    assert.equal(selected.length, 3);
    assert.deepEqual(selected.map(item => item.index), [0, 1, 2]);
    assert.deepEqual(selected.map(item => item.element.getAttribute('data-flat-index')), ['0', '1', '2']);
    assert.deepEqual(selected.map(item => item.element.getAttribute('data-message-id')), [null, null, null]);
  });

  it('dedupes nested transitional flat-index and message-index matches', () => {
    const root = containerFor(`
      <article data-flat-index="7">
        <div class="composer-rendered-message" data-message-role="assistant" data-message-index="7"></div>
      </article>
    `);

    const selected = selectMessageWrappers(root);

    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.index, 7);
    assert.equal(selected[0]?.element.getAttribute('data-flat-index'), '7');
  });

  it('falls back to role-bearing composer-rendered-message nodes with positional indices', () => {
    const root = containerFor(`
      <div class="composer-rendered-message" data-message-role="user"></div>
      <div class="composer-rendered-message" data-message-role="assistant"></div>
    `);

    const selected = selectMessageWrappers(root);

    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map(item => item.index), [0, 1]);
    assert.deepEqual(selected.map(item => item.element.getAttribute('data-message-role')), ['user', 'assistant']);
  });

  it('falls back to role and message-id nodes when composer-rendered-message is absent', () => {
    const root = containerFor(`
      <section data-message-role="user" data-message-id="u1"></section>
      <section data-message-role="assistant" data-message-id="a1"></section>
    `);

    const selected = selectMessageWrappers(root);

    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map(item => item.index), [0, 1]);
    assert.deepEqual(selected.map(item => item.element.getAttribute('data-message-id')), ['u1', 'a1']);
  });
});
