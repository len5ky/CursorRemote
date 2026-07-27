# DICKTATOR Android V2

Thin Android client for the proven CursorRemote V1 voice HTTP contracts. It has no Android Auto support.

## Open and build

1. Open `apps/dicktator-android` in Android Studio.
2. Use JDK 17 and let Android Studio sync the Gradle project.
3. Run the `app` configuration on an Android 8.0+ device, or assemble it with a locally installed Gradle 8.9+:

```bash
gradle :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/`.

## Configure

- Enter the relay base URL, for example `https://cursorremote.example` or your Tailscale address.
- For a password-protected relay, enter either a relay bearer token or the configured web password. With a password, the app calls `POST /api/login` and stores the returned bearer token in app-private storage. Both fields may be blank only for an intentionally unauthenticated local relay.
- The relay must run with `VOICE_ENABLED=true` and be reachable from the phone.
- HTTP is permitted for an existing LAN/Tailscale relay, but HTTPS is strongly preferred because bearer tokens authorize the session.

## Current scope

- `Connect` calls `/api/voice/token`, saves only the session ID and epoch, and starts an ongoing notification with **Hang Up**.
- The notification targets `VoiceSessionService`, so **Hang Up** sends `/api/voice/terminate` while the Activity is backgrounded.
- The API library also exposes `/api/voice/call`, `/disconnect`, `/heartbeat`, and `/status` for the native WebRTC/audio phase.
- Native WebRTC audio and Bluetooth SCO routing are intentionally not wired in this contract-first slice. The V1 relay remains authoritative and reaps an admitted session if no live call is attached.

## TODO

- Add native WebRTC audio, then route suitable Bluetooth headsets through SCO where required by the selected audio stack.
- Add FCM approval notifications. The notification payload must contain no relay bearer token and approval mutations must continue through the server's existing confirmation contract.
- Do not add Android Auto here; that is explicitly V3 scope.
