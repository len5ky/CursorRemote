// Private voice — one-page mobile call surface.
//
// Audio goes browser -> OpenAI Realtime directly over WebRTC. The relay only
// mints a short-lived ephemeral credential, admits the session, and attaches a
// server-side sideband using its own standard key. The relay never carries
// audio and the standard key never reaches this file.
//
// The ephemeral credential lives in a local variable for the duration of
// negotiation and is dropped on every terminal path. It is never persisted to
// browser storage, never placed in a URL, never logged, and never handed to a
// service worker cache.
(function (global) {
  'use strict';

  var OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
  var HEARTBEAT_INTERVAL_MS = 10000;
  var MAX_RECONNECT_ATTEMPTS = 1;
  var CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

  // Service worker scope. Must stay identical to `scope` in manifest.webmanifest:
  // a narrower worker scope leaves part of the installed app uncontrolled, a
  // wider one claims pages this PWA does not own. Prefix-matched by the browser.
  var VOICE_SCOPE = '/voice';

  // Only these states are surfaced. No transcript, no debug payloads.
  var UI = {
    idle: { text: 'Ready', button: 'Call', mode: 'idle', disabled: false },
    requesting_microphone: { text: 'Microphone requested', button: 'Connecting…', mode: 'busy', disabled: true },
    obtaining_secret: { text: 'Connecting', button: 'Connecting…', mode: 'busy', disabled: true },
    negotiating_webrtc: { text: 'Connecting', button: 'Connecting…', mode: 'busy', disabled: true },
    attaching_sideband: { text: 'Connecting', button: 'Connecting…', mode: 'busy', disabled: true },
    live: { text: 'Listening', button: 'Hang up', mode: 'active', disabled: false },
    speaking: { text: 'Speaking', button: 'Hang up', mode: 'active', disabled: false },
    reconnecting: { text: 'Reconnecting', button: 'Hang up', mode: 'active', disabled: true },
    ending: { text: 'Ending', button: 'Ending…', mode: 'busy', disabled: true },
    ended: { text: 'Ended', button: 'Call again', mode: 'idle', disabled: false },
    error: { text: 'Error', button: 'Call again', mode: 'idle', disabled: false }
  };

  function isLiveState(state) {
    return state === 'live' || state === 'speaking' || state === 'reconnecting';
  }

  // The states a call passes through on its way up. They are not live — there
  // is no media yet — but they may already hold a server session, so hanging up
  // or backgrounding the page during one of them still has work to do.
  function isConnectingState(state) {
    return state === 'requesting_microphone'
      || state === 'obtaining_secret'
      || state === 'negotiating_webrtc'
      || state === 'attaching_sideband';
  }

  function createVoiceCallController(env) {
    var fetchImpl = env.fetch;
    var mediaDevices = env.mediaDevices;
    var PeerConnection = env.PeerConnection;
    var remoteAudio = env.remoteAudio || null;
    var view = env.view;
    var timers = env.timers || {};
    var setIntervalImpl = timers.setInterval || global.setInterval;
    var clearIntervalImpl = timers.clearInterval || global.clearInterval;
    var sendBeacon = env.sendBeacon || null;

    var state = 'idle';
    var message = '';
    var messageTone = 'info';

    // Latches. `starting` blocks double-taps; `intentionalHangup` and
    // `serverEnded` each permanently suppress reconnect for this call.
    var starting = false;
    var intentionalHangup = false;
    var serverEnded = false;

    var pc = null;
    var dataChannel = null;
    var micStream = null;
    var sessionId = null;
    var epoch = null;
    var attachToken = null;
    var providerCallId = null;
    var heartbeatTimer = null;
    var reconnectAttempts = 0;

    function render() {
      var ui = UI[state] || UI.idle;
      view.render({
        state: state,
        stateText: ui.text,
        buttonLabel: ui.button,
        buttonMode: ui.mode,
        buttonDisabled: ui.disabled,
        message: message,
        messageTone: messageTone
      });
    }

    function setState(next, note, tone) {
      state = next;
      if (note !== undefined) {
        message = note;
        messageTone = tone || 'info';
      }
      render();
    }

    /**
     * Wrap a JSON string so sendBeacon declares application/json. Falls back to
     * the raw string where Blob is unavailable; the relay parses either form.
     */
    function beaconBody(json) {
      var BlobCtor = env.Blob || global.Blob;
      if (typeof BlobCtor !== 'function') return json;
      try {
        return new BlobCtor([json], { type: 'application/json' });
      } catch (e) {
        return json;
      }
    }

    function jsonHeaders() {
      // Auth rides the relay's HttpOnly session cookie. No credential is read
      // from browser storage and none is placed in a query string.
      return { 'Content-Type': 'application/json' };
    }

    function stopHeartbeat() {
      if (heartbeatTimer !== null) {
        clearIntervalImpl(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setIntervalImpl(function () { void sendHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
    }

    /** Stop every local capture track. Every terminal path routes through here. */
    function stopLocalMedia() {
      if (micStream && typeof micStream.getTracks === 'function') {
        var tracks = micStream.getTracks() || [];
        for (var i = 0; i < tracks.length; i++) {
          try { tracks[i].stop(); } catch (e) { /* already stopped */ }
        }
      }
      micStream = null;
    }

    function teardownPeer() {
      if (dataChannel) {
        try { dataChannel.close(); } catch (e) { /* already closed */ }
        dataChannel = null;
      }
      if (pc) {
        try { pc.close(); } catch (e) { /* already closed */ }
        pc = null;
      }
      if (remoteAudio) {
        try { remoteAudio.srcObject = null; } catch (e) { /* detached */ }
      }
    }

    /**
     * Idempotent local teardown plus best-effort server hangup. Correctness of
     * the server session never depends on this request arriving: the relay's
     * lease reaper is authoritative.
     */
    async function cleanup(options) {
      var opts = options || {};
      var endingSessionId = sessionId;
      var endingEpoch = epoch;

      stopHeartbeat();
      stopLocalMedia();
      teardownPeer();

      // Drop all call identity and credentials from memory.
      sessionId = null;
      epoch = null;
      attachToken = null;
      providerCallId = null;

      if (!opts.notifyServer || !endingSessionId || !Number.isInteger(endingEpoch)) return;

      var body = JSON.stringify({
        sessionId: endingSessionId,
        epoch: endingEpoch,
        reason: opts.reason || 'client_request'
      });

      if (opts.useBeacon && sendBeacon) {
        // A bare string beacon is sent as text/plain, which the relay would
        // have to sniff. A same-origin Blob carries an explicit
        // application/json content type and needs no preflight, so the relay
        // parses sessionId/epoch and can actually end the call.
        try { sendBeacon('/api/voice/terminate', beaconBody(body)); } catch (e) { /* best effort */ }
        return;
      }

      try {
        await fetchImpl('/api/voice/terminate', {
          method: 'POST',
          headers: jsonHeaders(),
          credentials: 'same-origin',
          body: body
        });
      } catch (e) {
        // The server reaper remains authoritative if this never lands.
      }
    }

    async function mintCredential() {
      var response = await fetchImpl('/api/voice/token', {
        method: 'POST',
        headers: jsonHeaders(),
        credentials: 'same-origin'
      });
      if (!response.ok) throw new Error('Could not start a call right now.');
      var body = await response.json();
      if (!body || typeof body.clientSecret !== 'string' || !body.clientSecret) {
        throw new Error('Could not start a call right now.');
      }
      if (typeof body.sessionId !== 'string' || !body.sessionId || !Number.isInteger(body.epoch)) {
        throw new Error('Could not start a call right now.');
      }
      if (typeof body.attachToken !== 'string' || !body.attachToken) {
        throw new Error('Could not start a call right now.');
      }
      sessionId = body.sessionId;
      epoch = body.epoch;
      attachToken = body.attachToken;
      return body.clientSecret;
    }

    function attachDataChannel(channel) {
      dataChannel = channel;
      if (!channel) return;
      channel.onmessage = function (event) {
        var payload;
        try { payload = JSON.parse(event.data); } catch (e) { return; }
        if (!payload || typeof payload.type !== 'string') return;
        // Barge-in: speaking silences whatever is being read out right now.
        // This is a local courtesy only — the relay owns turn semantics and
        // cancels superseded responses by id server-side. This file never
        // creates a response and never supplies response instructions; the only
        // thing it may do is stop one.
        if (payload.type === 'input_audio_buffer.speech_started') {
          if (state === 'speaking') setState('live');
          try { channel.send(JSON.stringify({ type: 'response.cancel' })); } catch (e) { /* channel gone */ }
          return;
        }
        if (payload.type === 'response.audio.delta' || payload.type === 'response.output_audio.delta') {
          if (state === 'live') setState('speaking');
          return;
        }
        if (payload.type === 'response.done' && state === 'speaking') setState('live');
      };
    }

    /** Negotiate media directly with the provider using the ephemeral credential. */
    async function negotiate(ephemeralCredential) {
      // `peer` is this negotiation's own connection. Every callback below closes
      // over it rather than reading the mutable `pc`, because a peer connection
      // keeps firing events after close() — a discarded connection's queued
      // event would otherwise be read against whichever peer is current, and a
      // stale 'closed' could tear down a healthy reconnected call.
      var peer = new PeerConnection();
      pc = peer;

      peer.ontrack = function (event) {
        if (peer !== pc) return;
        if (remoteAudio && event && event.streams && event.streams[0]) {
          remoteAudio.srcObject = event.streams[0];
        }
      };
      peer.onconnectionstatechange = function () {
        // Only the connection the call is actually using may decide its fate.
        if (peer !== pc) return;
        var connectionState = peer.connectionState;
        if (connectionState === 'failed' || connectionState === 'disconnected') {
          void handleTransportFailure();
        }
      };

      if (typeof peer.createDataChannel === 'function') {
        attachDataChannel(peer.createDataChannel('oai-events'));
      }

      var tracks = micStream.getTracks() || [];
      for (var i = 0; i < tracks.length; i++) peer.addTrack(tracks[i], micStream);

      var offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      var response = await fetchImpl(OPENAI_REALTIME_CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + ephemeralCredential,
          'Content-Type': 'application/sdp'
        },
        body: offer.sdp
      });
      var answerSdp = await response.text();
      if (!response.ok) throw new Error('The voice provider rejected the call.');

      var location = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('Location') || response.headers.get('location')
        : null;
      var callId = null;
      if (location) {
        var match = String(location).match(/\/calls\/([^/?#]+)(?:[/?#]|$)/);
        if (match) callId = match[1];
      }
      if (!callId || !CALL_ID_PATTERN.test(callId)) {
        throw new Error('The voice provider returned an unusable call.');
      }

      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      return callId;
    }

    async function attachSideband(callId) {
      var response = await fetchImpl('/api/voice/call', {
        method: 'POST',
        headers: jsonHeaders(),
        credentials: 'same-origin',
        body: JSON.stringify({
          callId: callId,
          sessionId: sessionId,
          epoch: epoch,
          attachToken: attachToken
        })
      });
      // The one-time grant is spent either way; it is never retried.
      attachToken = null;
      if (!response.ok) throw new Error('Could not connect this call to your workspace.');
    }

    async function sendHeartbeat() {
      if (!isLiveState(state) || !sessionId || !Number.isInteger(epoch)) return;
      try {
        var response = await fetchImpl('/api/voice/heartbeat', {
          method: 'POST',
          headers: jsonHeaders(),
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId: sessionId, epoch: epoch })
        });
        if (response.status === 409 || response.status === 403) {
          // The server ended this call (budget, expiry, or takeover). Never
          // reconnect after a server-side hangup.
          serverEnded = true;
          await cleanup({ notifyServer: false });
          setState('ended', 'The call was ended by the server.', 'info');
        }
      } catch (e) {
        // Transient; the server reaper stays authoritative.
      }
    }

    /**
     * The operator has already ended this call — by tapping Hang up, or by the
     * page being hidden — while it was still connecting.
     */
    function abandoned() {
      return intentionalHangup || serverEnded;
    }

    /**
     * Finish an abandoned start.
     *
     * Every step of the sequence is awaited, so a hangup lands *between* two of
     * them: the mint that was already in flight still returns a live server
     * session, and without this the sequence carried on negotiating, attached a
     * sideband and set `live` on top of the `ended` the operator had just asked
     * for. Cleanup is idempotent, and it notifies the server so the session
     * created mid-connect is released now rather than at the reaper.
     */
    async function abortStart() {
      await cleanup({ notifyServer: true, reason: 'client_request' });
      if (state !== 'ended') setState('ended', '');
    }

    async function runCallSequence() {
      setState('requesting_microphone', '');
      try {
        micStream = await mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        throw new Error('Microphone permission is required to place a call.');
      }
      if (abandoned()) return abortStart();

      setState('obtaining_secret');
      var ephemeralCredential = await mintCredential();
      if (abandoned()) {
        ephemeralCredential = null;
        return abortStart();
      }

      setState('negotiating_webrtc');
      providerCallId = await negotiate(ephemeralCredential);
      // Drop the provider credential the moment negotiation is done.
      ephemeralCredential = null;
      if (abandoned()) return abortStart();

      setState('attaching_sideband');
      await attachSideband(providerCallId);
      if (abandoned()) return abortStart();

      // Live only once media and sideband are both established. The reconnect
      // budget is deliberately NOT reset here: it is per call, not per
      // connection, so a flapping link cannot reconnect indefinitely. Only an
      // explicit Call from the user refreshes it.
      setState('live', '');
      startHeartbeat();
    }

    async function failCall(err) {
      var note = err && err.message ? String(err.message) : 'The call could not be completed.';
      await cleanup({ notifyServer: true, reason: 'connect_failed' });
      setState('error', note, 'error');
    }

    async function start() {
      if (starting || isLiveState(state) || state === 'ending') return;
      starting = true;
      intentionalHangup = false;
      serverEnded = false;
      reconnectAttempts = 0;
      try {
        await runCallSequence();
      } catch (err) {
        // A step that fails *after* the operator ended the call is not an error
        // they need to see; it is the call they already asked to end.
        if (abandoned()) await abortStart();
        else await failCall(err);
      } finally {
        starting = false;
      }
    }

    async function hangUp() {
      if (!isLiveState(state) && !isConnectingState(state) && !starting) return;
      // Latch before any awaited network work so a racing transport failure
      // cannot trigger a reconnect behind this hangup.
      intentionalHangup = true;
      setState('ending', '');
      await cleanup({ notifyServer: true, reason: 'client_request' });
      setState('ended', '');
    }

    async function handleTransportFailure() {
      if (intentionalHangup || serverEnded) return;
      if (!isLiveState(state)) return;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        await cleanup({ notifyServer: true, reason: 'transport_failed' });
        setState('error', 'The call dropped and could not be restored.', 'error');
        return;
      }
      reconnectAttempts++;
      setState('reconnecting', '');
      // Release the old server session first: reconnecting always mints a
      // fresh credential against a fresh epoch, never reuses the old one.
      await cleanup({ notifyServer: true, reason: 'transport_failed' });
      if (intentionalHangup || serverEnded) return;
      try {
        await runCallSequence();
      } catch (err) {
        await failCall(err);
      }
    }

    function handlePageHide() {
      // A page hidden mid-connect used to do nothing at all, so a phone locked
      // during setup left a paid server session running until the reaper found
      // it. The latch also stops the in-flight sequence from coming up live in
      // a page the operator can no longer see.
      if (!isLiveState(state) && state !== 'ending' && !isConnectingState(state) && !starting) return;
      intentionalHangup = true;
      void cleanup({ notifyServer: true, useBeacon: true, reason: 'page_hidden' });
    }

    function toggle() {
      if (isLiveState(state)) return hangUp();
      return start();
    }

    render();

    return {
      toggle: toggle,
      start: start,
      hangUp: hangUp,
      handlePageHide: handlePageHide,
      handleTransportFailure: handleTransportFailure,
      sendHeartbeat: sendHeartbeat,
      getState: function () { return state; },
      getMessage: function () { return message; },
      // Test seam only: reports whether call identity was dropped from memory.
      hasCallIdentity: function () { return sessionId !== null || attachToken !== null; }
    };
  }

  function bootstrap(doc) {
    var stateEl = doc.getElementById('call-state');
    var buttonEl = doc.getElementById('call-button');
    var messageEl = doc.getElementById('call-message');
    var audioEl = doc.getElementById('remote-audio');
    if (!stateEl || !buttonEl || !messageEl) return null;

    var controller = createVoiceCallController({
      // Resolved lazily so the page still parses in a browser without fetch;
      // the call button is the only thing that needs it.
      fetch: function (input, init) { return global.fetch(input, init); },
      mediaDevices: global.navigator.mediaDevices,
      PeerConnection: global.RTCPeerConnection,
      remoteAudio: audioEl,
      sendBeacon: global.navigator.sendBeacon
        ? global.navigator.sendBeacon.bind(global.navigator)
        : null,
      view: {
        render: function (model) {
          stateEl.textContent = model.stateText;
          buttonEl.textContent = model.buttonLabel;
          buttonEl.disabled = model.buttonDisabled;
          buttonEl.setAttribute('data-mode', model.buttonMode);
          buttonEl.setAttribute('aria-label', model.buttonLabel + '. ' + model.stateText + '.');
          messageEl.textContent = model.message;
          messageEl.setAttribute('data-tone', model.messageTone);
        }
      }
    });

    buttonEl.addEventListener('click', function () { void controller.toggle(); });
    global.addEventListener('pagehide', function () { controller.handlePageHide(); });

    if (global.navigator.serviceWorker && global.isSecureContext) {
      // Scope is explicit and matches the manifest. The default scope is the
      // worker's own directory — here the origin root — which would interpose
      // this worker on /api/*, /login and the whole remote-control client. The
      // worker is network-only, so that would not cache anything today, but the
      // voice PWA has no business being in the request path of surfaces it does
      // not own. '/voice' is prefix-matched, so it covers /voice, /voice.html
      // and the page's own assets and nothing else.
      global.navigator.serviceWorker.register('/voice-sw.js', { scope: VOICE_SCOPE }).catch(function () {
        // Installability is optional; calling works without it.
      });
    }

    return controller;
  }

  global.createVoiceCallController = createVoiceCallController;

  if (global.document && global.document.getElementById('call-button')) {
    global.__voiceController = bootstrap(global.document);
  }
})(typeof window !== 'undefined' ? window : globalThis);
