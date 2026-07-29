# DICKTATOR Android V2 (+ Android Auto) — unsupported on V1

> **Status: unsupported.** This native Android client was built against the
> pre-V1, mutation-capable voice surface. **CursorRemote V1 does not support
> it.** The supported V1 voice surface is the browser PWA at `/voice`.
>
> The sources are kept here for reference and for a possible future port. They
> are not built, tested, or shipped as part of V1, and the phone/Auto flows
> below will not work end to end against a V1 relay.

## Why it is unsupported

V1 made the voice surface **read-only**. Staged confirmation was removed
entirely, so the relay no longer serves the confirm/defer routes this client
calls. `VoiceApiClient` still posts to those paths, so the car surface's
Approve and Later buttons target routes that were removed and no longer exist,
and calls to them fail against any V1 relay.

The read-only tool boundary is deliberate: the V1 voice surface can read status
and recent context and end its own call, and can do nothing else. Restoring this
client would mean re-adding a mutation path that V1 removed on purpose.

## Supported alternative

Use the browser PWA. It is served by the relay itself and needs no build:

1. Run the relay with `VOICE_ENABLED=true` and a `WEBAPP_PASSWORD` set.
2. Open the relay over HTTPS (Tailscale is the expected transport).
3. Sign in, then open `/voice`.
4. Install it to the home screen when prompted — it is an installable PWA and
   works as a standalone call surface, including on Android.

The PWA negotiates WebRTC straight to the provider from the browser; the relay
mints a short-lived credential and attaches a server-side sideband. Audio never
transits the relay.

## Relay contract this client was written against

Of the routes this client uses, only these still exist on a V1 relay:

- `POST /api/login` — session cookie.
- `POST /api/voice/token` — mint an ephemeral client secret.
- `POST /api/voice/call` — attach the server-side sideband to a negotiated call.
- `POST /api/voice/heartbeat` — keep the lease alive.
- `POST /api/voice/terminate` — end the call.

The staged-confirmation routes it also calls were removed in V1 and are not
served by anything. Any client that depends on them is broken by definition.

## Building it anyway (reference only)

There is no supported build. If you are porting it:

1. Open `apps/dicktator-android` in Android Studio.
2. Use JDK 17 and let Android Studio sync the Gradle project.
3. Run the `app` configuration on a physical Android 8.0+ device, or:

```bash
./gradlew :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/`.

Expect the confirmation flow to fail against a V1 relay: those routes were
removed, so a port has to drop that surface rather than re-point it.

## Known gaps in the archived client

- This WSL host often lacks `ANDROID_HOME` — assemble on a machine with SDK 35.
- No physical car / DHU smoke was ever completed; Auto UX is uncertified.
- Phone bidirectional audio smoke was never completed.
