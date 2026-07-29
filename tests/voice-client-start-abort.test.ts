import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/voice-client-harness.js';

/**
 * Hanging up — or backgrounding the page — while the call is still connecting.
 *
 * `hangUp()` already latched `intentionalHangup` and set `ending`/`ended`, but
 * the start sequence it was racing kept going: it finished minting, negotiated
 * WebRTC, attached the sideband and then set `live` on top of the `ended` the
 * operator had just asked for. The button read "Hang up" for a call the
 * operator had already ended, and the server session it had just created was
 * left running to the reaper.
 *
 * `pagehide` did not fire at all during the connecting states, so a phone
 * locked mid-connect left a paid session behind with nothing to end it.
 *
 * These run the real `src/client/voice.js` inside JSDOM and assert on observed
 * behaviour — which requests went out, what the operator sees.
 */

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => { release = () => resolve(); });
  return { promise, release };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setImmediate(resolve));
}

describe('voice client — hang up while still connecting', () => {
  it('ends cleanly instead of going live behind the operator', async () => {
    const held = gate();
    const harness = createHarness({ holdToken: held.promise });

    const started = harness.controller.start();
    await settle();
    assert.equal(harness.controller.getState(), 'obtaining_secret', 'the call is mid-connect');

    const hungUp = harness.controller.hangUp();
    held.release();
    await Promise.all([started, hungUp]);
    await settle();

    assert.equal(harness.controller.getState(), 'ended', 'the operator asked to end the call, so it ends');
    assert.equal(harness.heartbeatActive(), false, 'no heartbeat survives an aborted start');
    assert.equal(harness.controller.hasCallIdentity(), false, 'call identity is dropped');
    assert.ok(harness.allTracksStopped(), 'the microphone is released');
    assert.ok(
      harness.countOf('/api/voice/terminate') >= 1,
      'the server session created mid-connect is released, not left to the reaper',
    );
    assert.ok(
      !harness.renders.some((render) => render.state === 'live'),
      'the aborted call must never present itself as live',
    );
  });

  it('does not attach a sideband for a call the operator already ended', async () => {
    const held = gate();
    const harness = createHarness({ holdToken: held.promise });

    const started = harness.controller.start();
    await settle();
    const hungUp = harness.controller.hangUp();
    held.release();
    await Promise.all([started, hungUp]);
    await settle();

    assert.equal(
      harness.countOf('/api/voice/call'),
      0,
      'an abandoned start must not go on to attach the server sideband',
    );
  });
});

describe('voice client — pagehide while still connecting', () => {
  it('releases the mid-connect session rather than leaving it to the reaper', async () => {
    const held = gate();
    const harness = createHarness({ holdToken: held.promise });

    const started = harness.controller.start();
    await settle();
    assert.equal(harness.controller.getState(), 'obtaining_secret');

    harness.controller.handlePageHide();
    held.release();
    await started;
    await settle();

    assert.equal(harness.controller.getState(), 'ended');
    assert.ok(harness.allTracksStopped(), 'the microphone is released when the page hides');
    assert.ok(
      harness.beacons.length + harness.countOf('/api/voice/terminate') >= 1,
      'the server is told to end the session that was being created',
    );
    assert.ok(
      !harness.renders.some((render) => render.state === 'live'),
      'a hidden page must not bring the call up live',
    );
  });

  it('still ignores pagehide when there is no call at all', async () => {
    const harness = createHarness();

    harness.controller.handlePageHide();
    await settle();

    assert.equal(harness.controller.getState(), 'idle');
    assert.equal(harness.beacons.length, 0, 'nothing to end, nothing sent');
    assert.equal(harness.countOf('/api/voice/terminate'), 0);
  });
});
