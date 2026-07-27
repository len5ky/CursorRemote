// DICKTATOR — voice "car mode" client v0. You dictate; they obey.
// Mints an ephemeral token from the relay, opens a WebRTC session directly to
// OpenAI Realtime, then reports the call id back so the server can attach the
// sideband channel that handles all tool calls. Audio never touches the relay.
(function () {
  'use strict';

  const btnVoice = document.getElementById('btn-voice');
  const panel = document.getElementById('voice-panel');
  const chip = document.getElementById('voice-status-chip');
  const targetEl = document.getElementById('voice-target');
  const btnToggle = document.getElementById('btn-voice-toggle');

  let pc = null;
  let micStream = null;
  let audioEl = null;
  let connected = false;
  let statusTimer = null;

  function authHeaders() {
    const token = localStorage.getItem('cursor-remote-token');
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  function setChip(state, label) {
    chip.className = 'voice-chip ' + state;
    chip.textContent = label;
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/api/voice/status', { headers: authHeaders(), credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.enabled) return;
      btnVoice.classList.remove('hidden');
      targetEl.textContent = data.target || 'no target';
      if (connected) setChip(data.connected ? 'live' : 'connecting', data.connected ? 'live' : 'linking');
    } catch (_) { /* relay unreachable */ }
  }

  async function connect() {
    setChip('connecting', 'connecting');
    btnToggle.disabled = true;
    try {
      const tokenRes = await fetch('/api/voice/token', {
        method: 'POST', headers: authHeaders(), credentials: 'same-origin',
      });
      if (!tokenRes.ok) throw new Error('token mint failed');
      const { value: ephemeralKey } = await tokenRes.json();

      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      pc = new RTCPeerConnection();
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };
      micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + ephemeralKey, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      if (!sdpRes.ok) throw new Error('WebRTC offer rejected');
      const callId = sdpRes.headers.get('Location')
        ? sdpRes.headers.get('Location').split('/').pop()
        : null;
      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      if (!callId) throw new Error('no call id in response');

      const attachRes = await fetch('/api/voice/call', {
        method: 'POST', headers: authHeaders(), credentials: 'same-origin',
        body: JSON.stringify({ callId }),
      });
      if (!attachRes.ok) throw new Error('sideband attach failed');

      connected = true;
      setChip('live', 'live');
      btnToggle.textContent = 'Disconnect';
      statusTimer = setInterval(refreshStatus, 5000);
    } catch (err) {
      console.error('[dicktator]', err);
      setChip('error', 'error');
      teardown(false);
    } finally {
      btnToggle.disabled = false;
    }
  }

  function teardown(notifyServer) {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (pc) { try { pc.close(); } catch (_) {} pc = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    audioEl = null;
    connected = false;
    btnToggle.textContent = 'Connect';
    if (notifyServer) {
      fetch('/api/voice/disconnect', {
        method: 'POST', headers: authHeaders(), credentials: 'same-origin',
      }).catch(() => {});
    }
  }

  function disconnect() {
    teardown(true);
    setChip('idle', 'off');
  }

  btnVoice.addEventListener('click', () => panel.classList.toggle('hidden'));
  btnToggle.addEventListener('click', () => (connected ? disconnect() : connect()));
  window.addEventListener('beforeunload', () => { if (connected) teardown(true); });

  refreshStatus();
})();
