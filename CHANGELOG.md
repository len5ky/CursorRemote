# Changelog

All notable changes to CursorRemote are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.1.40] - 2026-03-24

### Added
- Web plan modal now loads the full saved plan file so `View Plan` on the web matches Telegram's richer full-plan view.
- Web plan model picker now shows the real plan-scoped model options fetched from Cursor before applying the selection.

### Changed
- Web connection status now distinguishes relay connectivity from Cursor/CDP extraction health, including clearer waiting states during background throttling.
- DOM extraction polling now uses single-flight retries with timeout backoff so backgrounded Cursor windows degrade more gracefully instead of hammering failed evaluations.
- Plan widget interactions are now handled directly in the web UI for modal viewing and model selection, while Build still triggers the underlying Cursor action.

### Fixed
- Older browsers that do not support `crypto.randomUUID()` no longer crash the web client during command creation.
- Run/Skip/Allow approval widgets now render and update correctly in the web app, including command text for terminal approval cards.
- Web live updates now reconcile message type changes correctly instead of leaving stale `Generating` placeholders until manual refresh.
- Auto-scroll no longer snaps back to the latest message after the user intentionally scrolls up.
- Plan modal content no longer stops at the compact widget summary when the underlying saved plan file is available.

## [0.1.39] - 2026-03-24

### Added
- Native web code/diff renderer for assistant `codeBlocks` and tool `diffBlock`, with deterministic add/remove line styling.
- Mobile-friendly code block UX: ~7-line inline viewport with scroll and a full-screen reader.
- Telegram spoiler/shimmer mechanics for in-progress thought and activity presentation.

### Changed
- Assistant markdown HTML is now prose-only; code and diffs render from structured payloads instead of mirrored Cursor Monaco/Shiki HTML.
- Telegram formatter now maps structured code/diff blocks directly from `codeBlocks`.
- Activity state now uses a shared live-activity contract across relay, web, and Telegram.

### Fixed
- Removed brittle Monaco/Shiki mirror rendering and related duplicate, empty, or black code block failures in the web client.
- Native raw code blocks now preserve real newlines instead of flattening multiline code into a single `<code>` blob.
- Plain patch/unified-diff blocks are classified as diffs again, restoring red/green add/remove highlighting in the native renderer.
- Web app session persistence now survives re-login correctly instead of dropping saved auth/session state.
- Message sending reliability in the web app.
- Plan widget rendering and behavior in the web app.
- Explicit activity clearing now survives relay patch updates, so stale header shimmer/text does not persist in the web client.
- Telegram typing and ephemeral activity rows now stop based on live activity instead of stale status labels.
- Startup false positives like `Image generation stopped` no longer count as active work unless there is a real live signal.

## [0.1.38] - 2026-03-22

### Added
- Published to Open VSX registry so extension is searchable in Cursor's Extensions panel
- `--ovsx` flag in publish script to package and publish to Open VSX in one step

### Fixed
- Excluded `openvsx_token` from .vsix packaging and public repo sync

## [0.1.37] - 2026-03-21

### Added
- VS Code extension with auto-start, setup walkthrough, and status bar
- CDP bridge connecting to Cursor via Chrome DevTools Protocol
- DOM extraction of agent chat state (messages, tool calls, plans, approvals)
- Mobile web client with Cursor's dark theme
- Telegram bot transport with forum topic auto-creation
- Multi-window monitoring via parallel CDP connections
- Plan widget and run command widget support
- Mode and model switching from remote clients
- Chat tab switching and new chat creation
- License key validation
- Token-based Telegram registration
- Rate-limited message delivery with send queue
- Password-protected web client option
- Persistent Telegram state (topics, messages, sync, auth)
- Timestamped server logs to temp/server.log
- Extension icon and Marketplace listing
