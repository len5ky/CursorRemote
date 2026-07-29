import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './helpers/voice-client-harness.js';

/**
 * Peer-connection lifecycle under real event dispatch.
 *
 * `RTCPeerConnection` fires `connectionstatechange` asynchronously and keeps
 * firing after `close()`, so a call that has already reconnected still receives
 * events from the connection it discarded. Every assertion here drives the real
 * controller with fake peer/track objects and fires those events from a chosen
 * instance, because the bug being guarded against is precisely *which* instance
 * a callback reads — something no source-text check can see.
 */

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('voice client — connection events are attributed to their emitter', () => {
  it('ignores a superseded peer\'s late event instead of judging the live call by it', async () => {
    const h = createHarness();
    await h.controller.start();

    const stale = h.peers()[0];
    stale.drop();
    await settle();

    const live = h.peers()[1];
    assert.ok(live && live !== stale, 'the bounded retry must build a fresh peer');
    assert.equal(h.controller.getState(), 'live');
    assert.equal(stale.closed, true, 'the superseded peer must have been closed');

    const terminatesBefore = h.countOf('/api/voice/terminate');

    // The live peer is momentarily unhealthy but has not reported anything yet.
    // A browser can still deliver the *discarded* peer's queued 'closed' event
    // at this instant. That event says nothing about the live connection.
    live.connectionState = 'failed';
    stale.signal('closed');
    await settle();

    assert.equal(
      h.controller.getState(),
      'live',
      'a closed, superseded peer must not be able to tear down the live call',
    );
    assert.equal(
      h.countOf('/api/voice/terminate'),
      terminatesBefore,
      'a superseded peer\'s event must not spend the live session',
    );
    assert.equal(live.closed, false, 'the live peer must survive a stale peer\'s event');
  });

  it('acts on the live peer\'s own failure even while a stale peer looks healthy', async () => {
    const h = createHarness();
    await h.controller.start();

    const stale = h.peers()[0];
    stale.drop();
    await settle();

    const live = h.peers()[1];
    // The discarded peer is reported as healthy; only the live peer's own event
    // may decide the live call's fate.
    stale.connectionState = 'connected';
    live.signal('failed');
    await settle();

    assert.equal(h.controller.getState(), 'error', 'the live peer\'s own failure must be honoured');
    assert.equal(live.closed, true);
    assert.equal(h.allTracksStopped(), true);
    assert.equal(h.heartbeatActive(), false);
  });

  it('does not spend a second reconnect when the discarded peer repeats its failure', async () => {
    const h = createHarness();
    await h.controller.start();

    const first = h.peers()[0];
    first.drop();
    await settle();
    assert.equal(h.peers().length, 2);

    // The same discarded connection reports failure again, as a real peer does
    // while it finishes closing.
    first.signal('failed');
    first.signal('disconnected');
    await settle();

    assert.equal(h.peers().length, 2, 'a discarded peer must not be able to force another negotiation');
    assert.equal(h.countOf('/api/voice/token'), 2, 'the reconnect budget is per call, not per event');
    assert.equal(h.controller.getState(), 'live');
  });
});

describe('voice client — bounded reconnect budget', () => {
  it('stops after the bounded retry no matter how many failures arrive', async () => {
    const h = createHarness();
    await h.controller.start();

    h.peers()[0].drop();
    await settle();
    h.peers()[1].drop();
    await settle();

    // A flapping link keeps firing; the budget is already spent.
    for (const peer of h.peers()) {
      peer.signal('failed');
      peer.signal('disconnected');
    }
    await settle();

    assert.equal(h.controller.getState(), 'error');
    assert.equal(h.countOf('/api/voice/token'), 2, 'exactly one bounded retry per call');
    assert.equal(h.peers().length, 2, 'no peer may be built after the budget is spent');
    assert.equal(h.allTracksStopped(), true);
  });

  it('never negotiates two peers concurrently from overlapping failures', async () => {
    const h = createHarness();
    await h.controller.start();

    const peer = h.peers()[0];
    // Two failures land in the same tick, before the first has finished its
    // awaited teardown-and-renegotiate.
    const a = h.controller.handleTransportFailure();
    const b = h.controller.handleTransportFailure();
    peer.signal('failed');
    await Promise.all([a, b]);
    await settle();

    assert.equal(h.peers().length, 2, 'overlapping failures must produce one replacement peer, not two');
    assert.equal(h.countOf('/api/voice/token'), 2);
    assert.equal(h.controller.getState(), 'live');
  });
});

describe('voice client — terminal cleanup releases the microphone idempotently', () => {
  it('stops every track exactly once on a terminal transport failure', async () => {
    const h = createHarness();
    await h.controller.start();

    h.peers()[0].drop();
    await settle();
    h.peers()[1].drop();
    await settle();

    assert.equal(h.controller.getState(), 'error');
    assert.equal(h.streams.length, 2, 'the retry acquired a second capture stream');
    for (const track of h.allTracks()) {
      assert.equal(track.stopped, true, 'every track from every stream must be stopped');
      assert.equal(track.stopCount, 1, 'a stopped track must not be stopped again');
    }
  });

  it('stops every track on a server-side hangup and stays stopped under repeat events', async () => {
    const h = createHarness({ heartbeatStatus: 409 });
    await h.controller.start();
    await h.controller.sendHeartbeat();

    assert.equal(h.controller.getState(), 'ended');
    assert.equal(h.allTracksStopped(), true);

    // Late peer events after the server ended the call must change nothing.
    h.peers()[0].signal('failed');
    await h.controller.sendHeartbeat();
    await settle();

    assert.equal(h.controller.getState(), 'ended');
    assert.equal(h.countOf('/api/voice/token'), 1, 'a server hangup is never retried');
    for (const track of h.allTracks()) assert.equal(track.stopCount, 1);
  });

  it('stops every track on pagehide and tolerates a repeated pagehide', async () => {
    const h = createHarness();
    await h.controller.start();

    h.controller.handlePageHide();
    h.controller.handlePageHide();
    await settle();

    assert.equal(h.allTracksStopped(), true);
    assert.equal(h.peers()[0].closed, true);
    for (const track of h.allTracks()) {
      assert.equal(track.stopCount, 1, 'a repeated pagehide must not re-stop tracks');
    }
    assert.equal(h.beacons.length, 1, 'only the first pagehide has a session left to report');
  });

  it('stops tracks when the peer fails during pagehide teardown', async () => {
    const h = createHarness();
    await h.controller.start();

    const peer = h.peers()[0];
    h.controller.handlePageHide();
    peer.signal('failed');
    await settle();

    assert.equal(h.allTracksStopped(), true, 'the microphone must not survive the page');
    assert.equal(h.countOf('/api/voice/token'), 1, 'a hiding page must not start a new call');
    assert.equal(h.peers().length, 1);
  });
});
