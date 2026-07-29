// Private voice service worker — installability only, network-only by design.
//
// This worker deliberately holds NO storage. It never opens a cache and never
// stores a response, so it cannot retain:
//   /api/voice/token, /api/voice/call, /api/voice/status,
//   /api/voice/heartbeat, /api/voice/terminate, authentication responses,
//   conversation context, SDP, ephemeral credentials, or provider responses.
//
// Offline calling, background sync and push are explicit non-goals. If a future
// release wants precaching of the static shell, it must still exclude every
// path above; today the simplest correct policy is to store nothing at all.

self.addEventListener('install', function (event) {
  // Take over immediately; there is no cache to warm.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  // Pass every request straight to the network, untouched and unstored.
  event.respondWith(fetch(event.request));
});
