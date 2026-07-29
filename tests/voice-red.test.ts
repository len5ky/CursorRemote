import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSessionConfig } from '../src/server/transports/voice/realtime-bridge.js';
import { testVoiceConfig } from './helpers/voice-fixtures.js';

const root = join(import.meta.dirname, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

const config = testVoiceConfig;

describe('private voice recovery RED inventory', () => {
  it('removes staged confirmation from the voice source and public relay surface', () => {
    const voiceIndex = read('src/server/transports/voice/index.ts');
    const bridge = read('src/server/transports/voice/realtime-bridge.ts');
    const relay = read('src/server/relay.ts');
    assert.doesNotMatch(voiceIndex, /pendingConfirm|confirmLatest|deferLatest|latestPending|confirm_pending/);
    assert.doesNotMatch(bridge, /PendingConfirmation|latestPending|deferPending|confirm_pending/);
    assert.doesNotMatch(relay, /api\/voice\/(confirm|defer)/);
  });

  it('severs the voice composition graph from CommandExecutor and mutation callbacks', () => {
    const voiceIndex = read('src/server/transports/voice/index.ts');
    const bridge = read('src/server/transports/voice/realtime-bridge.ts');
    assert.doesNotMatch(voiceIndex, /CommandExecutor|commandExecutor|mutationHealth|activateTarget|sendMessage|clickApproval|clickAction|setMode|setModel/);
    assert.doesNotMatch(bridge, /activateTarget|sendMessage|clickApproval|clickAction|setMode|setModel|mutationHealth/);
  });

  it('pins every provider session to the exact required model', () => {
    const session = buildSessionConfig(config()).session as { model?: string };
    assert.equal(session.model, 'gpt-realtime-2.1');
  });

  it('does not ship a deterministic conversational fixture in production source', () => {
    const hermes = read('src/server/transports/voice/hermes-chat.js'.replace('.js', '.ts'));
    assert.doesNotMatch(hermes, /DeterministicVoiceContextAdapter|Deterministic read-only context/);
    // The only conversational content in production comes back over the wire
    // from the configured Hermes deployment, and an unusable route fails closed.
    assert.match(hermes, /assertVoiceHermesRoute|resolveVoiceHermesRoute/);
    assert.match(hermes, /HermesSessionChatClient/);
  });

  it('has no Realtime tool surface left for the provider to hold a conversation with', () => {
    const session = buildSessionConfig(config()).session as { tools?: unknown[]; tool_choice?: string };
    assert.deepEqual(session.tools, []);
    assert.equal(session.tool_choice, 'none');
  });

  it('has a dedicated minimal online-only PWA shell and network-only worker', () => {
    assert.equal(existsSync(join(root, 'src/client/voice.html')), true);
    assert.equal(existsSync(join(root, 'src/client/manifest.webmanifest')), true);
    assert.equal(existsSync(join(root, 'src/client/voice-sw.js')), true);
    const worker = read('src/client/voice-sw.js');
    assert.match(worker, /network|fetch/i);
    assert.doesNotMatch(worker, /caches\.(open|put)|CacheStorage/i);
  });

  it('does not put ephemeral or application credentials in persistent browser storage', () => {
    const client = read('src/client/voice.js');
    assert.doesNotMatch(client, /localStorage\.(setItem|getItem).*?(secret|token|credential)|sessionStorage\.(setItem|getItem).*?(secret|token|credential)/i);
    assert.doesNotMatch(client, /console\.(log|warn|error).*?(ephemeral|client.?secret|Bearer)/i);
  });
});
