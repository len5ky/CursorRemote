# DICKTATOR Android V2 (+ Android Auto)

Thin Android client for CursorRemote V1 voice HTTP contracts, with native WebRTC
and an Android Auto template surface (Talk / Approve / Later / Hang Up).

## Open and build

1. Open `apps/dicktator-android` in Android Studio.
2. Use JDK 17 and let Android Studio sync the Gradle project.
3. Run the `app` configuration on a physical Android 8.0+ device, or:

```bash
./gradlew :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/`.

## Configure (phone app first)

- Enter the relay base URL (Tailscale / HTTPS preferred).
- Optional bearer token or relay password (`POST /api/login`).
- Relay must run with `VOICE_ENABLED=true`.
- Grant **microphone** permission on the phone before using Auto **Talk**.

## Phone scope

- Connect → mint token → native WebRTC to OpenAI → `/api/voice/call` → 10s heartbeat.
- Hang Up (UI + notification) stops local media first, then `/api/voice/terminate`.
- Status shows sticky target, state, idle, budget, and pending confirmation summary.

## Android Auto path (human-drivable)

1. Install the debug APK; open the phone app; set relay URL (+ auth); grant mic.
2. Connect the phone to a car / DHU / Desktop Head Unit that supports template hosts.
3. Open **DICKTATOR** on the car display.
4. **Talk** starts the same `VoiceSessionService` WebRTC session as the phone Connect button.
5. When the relay has a staged confirmation, the car shows its summary; **Approve** calls `POST /api/voice/confirm` (latest pending for the live session); **Later** calls `POST /api/voice/defer` (drop without execute).
6. **Hang Up** stops local audio then terminates the relay session.

## Remaining / external blockers

- This WSL host often lacks `ANDROID_HOME` — assemble on a machine with SDK 35.
- Physical car / DHU smoke required for Auto UX certification; phone bidirectional audio smoke still required (Stage 2 soft concern).
- Push to `len5ky/CursorRemote` may 403 for jbovard2016 (local commits OK).
