# Changelog

All notable changes to CursorRemote are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.1.42] - 2026-03-27

### Added
- Questionnaire widget: agent multiple-choice questions (`.composer-questionnaire-toolbar`) are now extracted from the DOM, rendered in the web app with clickable option buttons and skip/continue actions, and formatted with inline keyboard buttons in Telegram.
- Regression test suite with 82 tests covering activity derivation, Telegram formatting (including questionnaire and assistant empty-html handling), and web client rendering (including questionnaire widget). Runs via `npm test` and is required before every publish.
- Generic tool action extraction: all tool types (including Fetch, and any future Cursor tools) now surface Skip/Run/Allowlist buttons in both the web app and Telegram, without needing per-tool-type code.
- Browser notifications now fire for all actionable events — run command prompts, tool-level approvals (Fetch, Edit, etc.), not just global approvals. Each notification is deduplicated by message ID.
- Canonical fixture library (`fixtures/recordings/`) with scenarios for shimmer lifecycle, approvals, plans, code blocks, connection states, and fetch tool.
- Manual smoke checklist (`docs/smoke-checklist.md`) for pre-release verification.

### Changed
- Web client is no longer fixed to a narrow 600px mobile layout. The app now fills the full viewport width, with message content centered and capped at ~800px on desktop for readability. Mobile layout is unchanged.
- CDP recorder now stores both raw extractor output and post-derived relay state, with schema versioning and metadata header.
- Publish script (`scripts/publish.ts`) now gates on regression tests before syncing to the public repo. Use `--skip-tests` only for emergencies.
- Deduplicated button extraction logic in `dom-extractor.ts` into a single `extractToolActions()` helper used by all tool paths.

### Fixed
- Telegram assistant messages no longer flash unformatted text (missing spaces/formatting) before showing the properly formatted version. Messages now wait for HTML rendering before being sent.
- Model and mode now sync correctly across windows. Per-window model/mode is captured in window snapshots and pushed to global state immediately on window switch, eliminating stale values from the previous window.
- Model extraction no longer picks up the plan-scoped model dropdown (e.g. "Opus 4.6" from a plan widget) instead of the actual composer model. Windows with active plan widgets now correctly report the composer-level model.
- Fetch tool (and other compact tool types) now show their content and approval buttons in both Telegram and the web app instead of appearing as plain text with no actions.
- Compact tool header extraction no longer picks up button text ("Skip", "Allowlist ...") as the action/description.

## [0.1.41] - 2026-03-24

### Fixed
- Extension packaging now ships a vendored Socket.IO browser client so the web app loads correctly from a clean VSIX install without `node_modules`. Previously the server relied on Socket.IO's internal `client-dist/` files which were not included in the bundled extension package, causing `io is not defined` and a blank page on first use.
- Added favicon to the web client so browsers no longer 404 on `/favicon.ico`.

### Changed
- The publish script now always rebuilds the `.vsix` instead of reusing a potentially stale cached artifact, and runs a VSIX content verifier before publishing.
- Added a VSIX verification step (`scripts/verify-vsix.ts`) that checks for required runtime files and forbidden secrets before every package and publish.

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
