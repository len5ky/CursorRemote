# DICKTATOR Android V2

Thin Android client for the proven CursorRemote V1 voice HTTP contracts. It has no Android Auto support.

## Open and build

1. Open `apps/dicktator-android` in Android Studio.
2. Use JDK 17 and let Android Studio sync the Gradle project.
3. Run the `app` configuration on a physical Android 8.0+ device, or assemble it with the checked-in Gradle Wrapper:

```bash
./gradlew :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/`.

## Configure

- Enter the relay base URL, for example `https://cursorremote.example` or your Tailscale address.
- For a password-protected relay, enter either a relay bearer token or the configured web password. With a password, the app calls `POST /api/login` and stores the returned bearer token in app-private storage. Both fields may be blank only for an intentionally unauthenticated local relay.
- The relay must run with `VOICE_ENABLED=true` and be reachable from the phone.
- HTTP is permitted for an existing LAN/Tailscale relay, but HTTPS is strongly preferred because bearer tokens authorize the session.

## Current scope

- `Connect` requests microphone permission, then the foreground `VoiceSessionService` mints an ephemeral token, captures the microphone with native WebRTC, posts the SDP offer directly to OpenAI Realtime, applies the answer, and attaches the OpenAI call ID to the relay.
- Audio flows only between the phone and OpenAI. The relay receives the call ID, token, heartbeat, and termination requests; it never receives audio.
- The ongoing notification and the in-app **Hang Up** action stop local microphone/playback and close the peer connection before calling `/api/voice/terminate`, then clear local session state and stop the foreground service.
- Status shows the relay's sticky target, session state, and idle/budget fields when the V1 status response provides them.

## Device requirements

- A physical device is required for meaningful microphone and remote playout verification. An emulator can compile the app but is not a substitute for a real audio route.
- Android Studio includes the required Android SDK. For command-line builds, install Android SDK Platform 35 and set `ANDROID_HOME` (or create `local.properties` with `sdk.dir=/path/to/Android/Sdk`).
- The app requests `RECORD_AUDIO` at runtime and declares the Android 14+/target SDK 35 microphone and media-playback foreground-service permissions.

## Remaining scope

- Verify handset, wired, and Bluetooth routing on representative physical devices. Explicit SCO routing is deferred unless the selected WebRTC audio device module fails to select the active system route.
- Add FCM approval notifications. The notification payload must contain no relay bearer token and approval mutations must continue through the server's existing confirmation contract.
- Do not add Android Auto here; that is explicitly V3 scope.
