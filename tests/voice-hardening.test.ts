import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeBridge, parseUsageFromDone } from '../src/server/transports/voice/realtime-bridge.js';
import { VoiceToolRouter } from '../src/server/transports/voice/tools.js';
import { VoiceSessionController } from '../src/server/transports/voice/session.js';
import type { VoiceConfig } from '../src/server/types.js';
import { testVoiceConfig } from './helpers/voice-fixtures.js';
import { KNOWN_VOICE_PRICE_VERSION } from '../src/server/transports/voice/pricing.js';

function config(): VoiceConfig {
  return testVoiceConfig({
    sessionAbsoluteMs: 60_000,
    sessionIdleMs: 1_000,
    sessionIdleGraceMs: 500,
    sessionLeaseMs: 2_000,
  });
}

describe('voice hardening — provider hangup recovery', () => {
  it('retries a transient provider hangup failure without exposing the server key', async () => {
    let attempts = 0;
    const bridge = new RealtimeBridge(config(), {} as VoiceToolRouter, {
      accepts: () => true,
      userTurn: () => {},
      providerFailure: () => {},
      reportSpend: () => false,
    }, {
      fetchImpl: (async () => {
        attempts += 1;
        return new Response(null, { status: attempts === 1 ? 500 : 204 });
      }) as typeof fetch,
    });
    assert.equal(await bridge.hangup('call-1'), true);
    assert.equal(attempts, 2);
  });
});

describe('voice hardening — provider usage provenance', () => {
  it('accepts explicit provider cents and audio duration, but not token-only usage', () => {
    assert.deepEqual(parseUsageFromDone(JSON.stringify({
      type: 'response.done', response: { usage: { cost_cents: 4, output_tokens: { audio_duration_ms: 12_000 } } },
    })), { reportedCents: 4, audioDurationMs: 12_000 });
    assert.deepEqual(parseUsageFromDone(JSON.stringify({
      type: 'response.done', response: { usage: { output_tokens: { text_duration_ms: 12_000 } } },
    })), null);
    assert.equal(parseUsageFromDone('{bad json'), null);
  });
});

describe('voice hardening — idle and budget brakes', () => {
  it('does not let heartbeat refresh user idleness and reaps after the grace window', () => {
    let now = 10_000;
    const controller = new VoiceSessionController({
      dataPath: `/tmp/private-voice-hardening-${process.pid}.json`,
      priceVersion: KNOWN_VOICE_PRICE_VERSION,
      unitPriceCentsPerMinute: 1,
      dailyCapCents: 100,
      perSessionCapCents: 10,
      absoluteSessionMs: 60_000,
      idleMs: 1_000,
      idleGraceMs: 500,
      leaseMs: 10_000,
    }, () => now);
    const admitted = controller.admit('account-a');
    assert.equal(admitted.ok, true);
    const context = admitted.context!;
    assert.equal(controller.activate(context), true);
    now += 1_200;
    assert.equal(controller.heartbeat(context.sessionId, context.epoch), true);
    assert.equal(controller.status().idleStatus, 'idle_grace');
    now += 400;
    assert.equal(controller.reap()[0]?.reason, 'idle_timeout');
  });
});
