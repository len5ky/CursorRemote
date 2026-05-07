# Changelog

All notable changes to CursorRemote are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.1.45] - 2026-05-07

### Fixed
- **Approval banners broken for current Cursor UI**: recent Cursor builds render shell tool approvals with a per-card layout (`Run` / `Skip` / `Allowlist '<cmd>'` plus an `Auto-Run in Sandbox` mode-dropdown trigger). The relay was matching the dropdown trigger via a generic `Run` text-substring match, so clicking Approve in the web client or Telegram opened a settings menu in Cursor instead of approving — users couldn't get unstuck without going to the IDE. Approval extraction now identifies the real action buttons by class (`.ui-shell-tool-call__run-btn`, `.ui-shell-tool-call__skip-btn`, `.ui-shell-tool-call__allowlist-button`) and skips any element with `aria-haspopup` (always a menu, never an action). Closes [public#12](https://github.com/len5ky/CursorRemote/issues/12).
- **Approval description shows the actual command** (e.g. `curl -sI --max-time 5 https://example.com | head -n 3`) instead of a generic button label like "Auto-Run in Sandbox". Useful in Telegram, where you previously had no way to see what you were approving without switching to Cursor.
- **Stuck approval banner in multi-agent / multi-composer setups**: approve/reject button discovery used `document.querySelectorAll`, so the relay matched buttons from other composers and sticky workbench chrome. Once a composer's approval was clicked the state never cleared because stale buttons in *other* composers kept surfacing. Approval extraction is now scoped to the active chat container and de-duped, mirroring how the rest of the extractor already worked. Originally credited as a community fix; see [public#15](https://github.com/len5ky/CursorRemote/pull/15) (thanks @gavinc).
- **Multi-window approvals now reach Telegram**: with multiple Cursor windows open, only the active CDP target's approvals were processed for Telegram — non-active windows were polled by `window-monitor` into per-window snapshots, but those approvals never reached the bot. Each window's approvals now route to its own Telegram thread via `doProcessWindow`. Per-id content-hash dedupe keeps the active window from being banner-spammed twice when both the global and per-window paths fire.
- **Cross-window approval routing**: when the user switches to a Cursor window that doesn't own the currently-selected agent (Cursor's global agent rail surfaces the same selected tab in every workbench DOM), the strict `(windowId, tab)` topic lookup returned nothing and the banner was silently dropped. Now falls through to a tab-title-only mapping lookup so the banner still surfaces in the canonical topic.
- **Two different agents with the same tab title in different projects no longer share one Telegram topic.** The cross-window routing fix above wrongly conflated them when they shared a name (e.g. "Shell command approval process" in two projects). Topics are now identified by `data-composer-id` (Cursor's stable per-agent ID) instead of just tab title, so the same agent shown via Cursor's global rail in another window still routes to one topic, while two genuinely different agents that coincidentally share a title get their own topics auto-created.
- **Same agent seen via the new 'Cursor Agents' window no longer mints a duplicate topic.** When a user opens an agent in the global Cursor Agents window after already having a topic for it (created earlier from the project's own workbench window), the relay would create a fresh topic because the composite `<group>/<agent>` tab title doesn't match the original tab title key. `autoCreateTopic` now consults composerId across all existing mappings before minting, and reuses the existing topic if found. `/dedupe` also groups by composerId so any historical duplicates can be collapsed in one command.
- **Telegram approval banner deletion no longer flickers**: previously each transient empty `pendingApprovals` poll deleted the banner, and the next poll re-sent it — visible re-creation every ~10s while an approval was outstanding. Now defers deletion by 30 seconds (3× window-monitor cycle) so DOM transients are absorbed.
- **No more duplicate approval banners from concurrent paths**: the global state-patch path and the per-window `doProcessWindow` path could both call the approval send routine for the same approval id within milliseconds of each other; both saw an empty tracker (because neither had called `track()` yet), both called `sendMessage`, and the user got two banners (confirmed live as msgIds 10352 + 10353 for one approval). Guarded with an inflight Set keyed on `${threadId}:${trackId}`.
- **Telegram approval tracking per-id** (was: single `approval` key per thread that edited the same message in place). New approvals now appear as fresh banners at the bottom of the topic instead of silently rewriting an old banner far up in the chat. Multiple concurrent approvals get separate banners.
- **Duplicate Telegram topics on WSL/SSH reconnect**: Cursor adds connection-context suffixes to window titles when projects are opened over WSL/SSH/Codespaces (`myproj` vs `myproj [WSL: ubuntu-24.04]`). The relay treated those as different windows and created a parallel topic tree per (project × connection mode). Window titles are now normalized for matching, so reopening a project under a different connection mode reuses the existing topic.
- **Cursor Agents window now lists all agents, not just the active one.** Recent Cursor builds host a dedicated 'Cursor Agents' workbench window with a glass-sidebar rail showing every agent across every project, grouped by project. The relay's legacy `.agent-sidebar-cell` selector only matched the visible active row in that window, so the web client showed exactly one switchable agent there. Now extracts every `.glass-sidebar-agent-list-container li.ui-sidebar-menu-item > div.glass-sidebar-agent-menu-btn` row and builds composite `<group> / <agent>` titles so two agents with the same name in different projects don't collide. `switchTab` understands both the composite and the agent-only forms. Legacy `.agent-sidebar-cell` extraction is preserved as a fallback for older Cursor builds. Closes [public#13](https://github.com/len5ky/CursorRemote/issues/13); see [public#14](https://github.com/len5ky/CursorRemote/pull/14) (thanks @gavinc).
- **Web client mobile multi-line input**: on touch devices Enter now inserts a newline instead of sending the message — previously you couldn't compose multi-line prompts on a phone because mobile keyboards have no Shift+Enter. Tap the Send button to send. Cmd/Ctrl+Enter always sends regardless of platform (handy for hardware keyboards on tablets, familiar on desktop). Closes [public#5](https://github.com/len5ky/CursorRemote/issues/5).
- **iOS questionnaire scrolling**: when the agent presents 3+ questions on iOS Safari, the questionnaire panel no longer overflows off-screen. Caps `.questionnaire-bar` at `max-height: 55vh` with `#questionnaire-questions` independently scrollable (with iOS momentum); header and Skip/Continue stay pinned. Closes [public#8](https://github.com/len5ky/CursorRemote/issues/8); see [public#7](https://github.com/len5ky/CursorRemote/pull/7) (thanks @hfutrell-gss).
- Stopped log spam: the `Skipping ... already belongs to ...` warning fired every 10s for every (non-owning window, tab) pair when Cursor's global agent rail is in use. Now logged once per pair.
- Persisted message tracker now self-heals legacy approval keys (`approval`, `approval-approval-<TS>`) from prior code revisions that accumulated thousands of stale entries on disk.

### Added
- **`/dedupe` Telegram command** — preview and merge duplicate topic mappings created across WSL/SSH variants of the same project. `/dedupe` shows a preview with `KEEP` / `DROP` markers; `/dedupe yes` deletes the orphan topics and removes their mappings. Companion to the title-normalization fix above for cleaning up topics from before this release.
- **`/resync` Telegram command** — run inside a topic to rebind it to whatever Cursor has active right now. Useful when Cursor's global agent rail has surfaced an agent in a window other than the one that originally created the topic, and the topic's window prefix no longer matches where you actually work. Also renames the Telegram topic if the bot has Manage Topics permission. Refuses if the new target is already bound to a different topic (suggests `/dedupe` in that case).
- **`/debug/state` HTTP endpoint** (auth-gated) returning current `activeWindowId`, `agentStatus`, `pendingApprovals`, `chatTabs` (with active flags), `windows`, and recent message types. Indispensable when debugging which window/tab a state field is coming from without parsing socket.io traffic.
- `[telegram-api] send thread=N msgId=M text=...` log line on every outbound Telegram API call, for tracing duplicate-send issues across multiple bot instances or transports.
- `scripts/probe-tabs.ts` — connects to a given Cursor window via CDP and dumps tab/composer markers (active flags, `data-composer-id`, `data-composer-status`, ARIA attributes) for debugging selector regressions.
- `scripts/probe-tg-thread.ts` — sends a one-off probe message to a specific (chat, thread) to verify whether a Telegram topic exists outside of our tracker, used to discover orphan topics created by other bot instances.

### Known issues
- **Two bot instances writing to the same Telegram chat will both succeed** (extension-spawned server + dev server using the same token). Both will appear to work but messages get duplicated across each instance's mapping set. Stop one before running the other; see "Dev mode" below.

## [0.1.44] - 2026-04-07

### Fixed
- **Telegram approval spam**: approval messages no longer flood the chat. Root cause was `Date.now()` in the approval ID causing every poll cycle to generate a "new" approval that bypassed message tracking. Now uses a deterministic ID based on button labels, and adds content-hash dedup so unchanged approvals are never re-sent.
- Questionnaire options in the web app now display vertically with full text instead of being squeezed into small horizontal pills that cut off long answers.
- Questionnaire options in Telegram now appear as individual full-width keyboard buttons (one per row) with option text also shown in the message body for readability.
- Questionnaire now appears in Telegram immediately even when shown alongside a plan widget. Previously the first question was silently dropped because the questionnaire was only processed via `state:patch` (which depends on a thread mapping that may not exist yet), while plan messages were processed via `window:update` (which creates the thread). Now the questionnaire is also processed at the end of `doProcessWindow` using the guaranteed thread ID.
- Telegram questionnaire now shows ALL questions (not just the active one), with `👉` marking the current question. This prevents questions from being lost if the active index advances between poll cycles.

## [0.1.43] - 2026-04-06

### Added
- "Clear License Key" command (`CursorRemote: Clear License Key` in Command Palette) to delete the stored license from OS secret storage, useful for testing the activation flow.
- Telegram command logging: incoming bot commands (e.g. `/status`, `/sync`) now appear in the server log with the sender's username.
- **Raw Telegram transport** (`TELEGRAM_IMPL=raw`): an alternative Telegram bot implementation that talks directly to the Bot API via `fetch` with explicit 30s HTTP timeouts, bypassing Grammy entirely. Use this if Grammy hangs during startup (commonly on macOS with flaky Telegram connectivity). Grammy remains the default; set `TELEGRAM_IMPL=raw` in `.env` or the VS Code extension settings to switch. Both implementations share the same command handlers, formatter, topic manager, and message tracking logic.
- `docs/telegram-troubleshooting.md` — guide for Telegram startup hangs, connectivity, 409 conflicts, and switching to the raw transport.

### Changed
- Model selector in the web client and Telegram `/model` command now reads available models directly from Cursor's model picker menu instead of using a hardcoded list. The sheet shows a loading state while fetching, caches results for instant re-opens, and gracefully handles fetch failures.
- CDP target discovery log now shows only page targets with a compact summary for the rest (e.g. `Found 5 page(s) (+21 iframe, 4 webview, 9 worker)`) instead of dumping every iframe/webview/worker.
- Telegram bot startup is more resilient and verbose: Grammy's fetch calls now have a 30s HTTP timeout (previously no timeout — could hang forever on stale TCP connections), `autoRetry` max delay reduced from 60s to 10s, `bot.init()` and long-poll startup phases are logged separately, and a 30s watchdog warns if the polling loop doesn't connect.
- `deleteWebhook` now passes `drop_pending_updates=true` and `bot.start()` uses `drop_pending_updates` to avoid choking on stale updates from a previous session.
- `setMyCommands` moved to after `bot.init()` to avoid burning Telegram rate-limit budget before the bot is initialized.

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
