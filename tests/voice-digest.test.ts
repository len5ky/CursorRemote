import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeForSpeech,
  buildDigestPrompt,
  elementsToDigestLines,
  fallbackDigest,
  DigestClient,
  DIGEST_SYSTEM_PROMPT,
} from '../src/server/transports/voice/digest.js';
import type { CursorState, ChatElement } from '../src/server/types.js';

function baseState(overrides: Partial<CursorState> = {}): CursorState {
  return {
    connected: true,
    extractorStatus: 'ok',
    lastExtractionAt: Date.now(),
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: 'running_tool',
    agentActivityText: 'Editing files',
    agentActivityLive: true,
    agentActivitySource: 'shimmer',
    messages: [],
    pendingApprovals: [],
    inputAvailable: true,
    chatTabs: [],
    activeComposerId: '',
    mode: { current: 'agent', available: [] },
    model: { current: 'Auto', currentId: 'auto' },
    windows: [],
    activeWindowId: '',
    composerQueue: { items: [] },
    questionnaire: null,
    ...overrides,
  };
}

describe('sanitizeForSpeech', () => {
  it('strips unix file paths', () => {
    const out = sanitizeForSpeech('Edited /home/user/src/server/index.ts today');
    assert.ok(!out.includes('/home/user'));
    assert.match(out, /a file path/);
  });

  it('strips commit hashes', () => {
    const out = sanitizeForSpeech('Committed f855212abc1234 to the branch');
    assert.ok(!out.includes('f855212abc1234'));
  });

  it('strips URLs', () => {
    const out = sanitizeForSpeech('See https://example.com/docs for info');
    assert.ok(!out.includes('https://'));
  });

  it('replaces code fences and inline code', () => {
    const out = sanitizeForSpeech('Run `npm test` then ```const x = 1;``` done');
    assert.ok(!out.includes('npm test'));
    assert.ok(!out.includes('const x'));
  });
});

describe('digest prompt shaping', () => {
  it('system prompt bans paths and hashes', () => {
    assert.match(DIGEST_SYSTEM_PROMPT, /file paths/i);
    assert.match(DIGEST_SYSTEM_PROMPT, /2-3 short spoken sentences/i);
  });

  it('prompt includes status, approvals, and transcript lines', () => {
    const state = baseState({
      pendingApprovals: [{ id: 'a1', description: 'Run rm -rf temp', actions: [] }],
    });
    const messages: ChatElement[] = [
      { type: 'human', id: 'h1', flatIndex: 0, text: 'fix the bug', mentions: [] },
      { type: 'tool', id: 't1', flatIndex: 1, toolCallId: 'tc', status: 'completed', action: 'Edit', details: 'server file' },
    ];
    const prompt = buildDigestPrompt(messages, state);
    assert.match(prompt, /Agent status: running_tool/);
    assert.match(prompt, /Pending approvals/);
    assert.match(prompt, /User asked: fix the bug/);
    assert.match(prompt, /Tool done: Edit/);
  });

  it('elementsToDigestLines skips loading elements', () => {
    const lines = elementsToDigestLines([
      { type: 'loading', id: 'l1', flatIndex: 0 },
    ]);
    assert.equal(lines.length, 0);
  });
});

describe('fallbackDigest', () => {
  it('describes waiting_approval status with approval count', () => {
    const state = baseState({
      agentStatus: 'waiting_approval',
      pendingApprovals: [{ id: 'a1', description: 'x', actions: [] }],
    });
    const out = fallbackDigest([], state);
    assert.match(out, /waiting for your approval/i);
    assert.match(out, /one pending approval/i);
  });
});

describe('DigestClient', () => {
  it('uses OpenRouter response and sanitizes it', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'The agent edited /src/app.ts and is done.' } }],
    }), { status: 200 })) as typeof fetch;
    const client = new DigestClient({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch });
    const out = await client.digest([], baseState());
    assert.ok(!out.includes('/src/app.ts'));
    assert.match(out, /is done/);
  });

  it('falls back on HTTP error', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const client = new DigestClient({ apiKey: 'k', model: 'm', fetchImpl: fakeFetch });
    const out = await client.digest([], baseState({ agentStatus: 'idle' }));
    assert.match(out, /idle/i);
  });

  it('falls back immediately without an API key', async () => {
    const client = new DigestClient({ apiKey: '', model: 'm' });
    const out = await client.digest([], baseState({ agentStatus: 'thinking' }));
    assert.match(out, /thinking/i);
  });
});
