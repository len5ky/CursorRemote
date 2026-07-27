# Graph Report - cursor-ide-remote  (2026-07-27)

## Corpus Check
- 95 files · ~159,322 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1456 nodes · 2785 edges · 103 communities (95 shown, 8 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 39 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7b43eb01`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- CdpClient
- server/types.ts
- ServerManager
- Changelog
- BaseTelegramTransport
- vendor-socket.io.min.js
- 6. Implementation Discoveries
- command-executor.ts
- telegram-raw/index.ts
- commands.ts
- cleanTabTitle
- CursorRemote
- 4. State Model
- Telegram Transport — Architecture Document
- publish.ts
- relay.ts
- base.ts
- CDP Record/Replay Tools
- devDependencies
- compilerOptions
- MessageTracker
- compilerOptions
- WindowMonitor
- 2. User Stories
- scripts
- CDPBridge
- dependencies
- package.json
- release.ts
- TelegramApiClient
- RawTelegramApiClient
- Topic Routing — Deep Analysis & Solution Plan
- Telegram Connection Troubleshooting
- web-client.test.ts
- 6. UI/UX Specification
- 2. User Stories
- 3. Message Format Specification
- server/index.ts
- SendQueue
- 2. User Stories
- Secure Access with Tailscale
- DOMExtractor
- StateManager
- CursorRemote — Extension PRD
- 11. Server-Side Enhancements
- CursorRemote — Product Requirements Document
- 2A. Extension Setup (Recommended)
- 4. Telegram Integration (Optional)
- Telegram Transport Module — Product Requirements Document
- enum
- 3. Network Access
- dev-wrapper.ts
- plan-files.ts
- Setup Guide -- CursorRemote
- properties
- contributes
- cursorRemote.telegram.impl
- app.js
- CLAUDE.md
- 12. Build and Distribution
- 1. Enable CDP on Cursor IDE
- Standalone-Specific
- General
- Pre-Release Smoke Checklist
- 8. Edge Cases
- 8. Setup Panel (WebviewPanel)
- 7. DOM Extraction Strategy
- 6. Troubleshooting
- 1. Install Tailscale on the Server
- 5. Topic Mapping
- 7. Rate Limiting and Constraints
- esbuild.js
- normalize-fixture.ts
- 1. Overview
- 7. Sidebar Tree View
- 10. Key Technical Decisions
- 1. Overview
- 3. System Architecture
- 9. Technical Requirements
- Chrome DevTools Protocol (CDP)
- Network Access
- cursorRemote.autoStart
- cursorRemote.cdpUrl
- cursorRemote.debounceMs
- cursorRemote.pollIntervalMs
- cursorRemote.serverHost
- cursorRemote.serverPort
- cursorRemote.telegram.allowedUsers
- cursorRemote.telegram.botToken
- cursorRemote.telegram.enabled
- cursorRemote.windowTitleQualifier
- You're all set!
- Telegram Bot Integration
- categories
- repository
- license.md
- Setup A: Extension (Recommended)
- 4. Component Details
- Setup B: Standalone Server (Without Extension)
- 6. Message Lifecycle

## God Nodes (most connected - your core abstractions)
1. `BaseTelegramTransport` - 55 edges
2. `CommandExecutor` - 44 edges
3. `CdpClient` - 42 edges
4. `StateManager` - 39 edges
5. `CDPBridge` - 38 edges
6. `WindowMonitor` - 38 edges
7. `CursorState` - 37 edges
8. `ServerManager` - 29 edges
9. `cleanTabTitle()` - 25 edges
10. `escapeHtml()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `parseHtml()` --indirect_call--> `t()`  [INFERRED]
  tests/model-picker-fallback.test.ts → src/client/vendor-socket.io.min.js
- `main()` --indirect_call--> `r()`  [INFERRED]
  scripts/probe-model-picker.ts → src/client/vendor-socket.io.min.js
- `main()` --indirect_call--> `r()`  [INFERRED]
  scripts/record-cdp.ts → src/client/vendor-socket.io.min.js
- `RecordLineV1` --references--> `CursorState`  [EXTRACTED]
  scripts/replay-cdp.ts → src/server/types.ts
- `RecordLineV2` --references--> `CursorState`  [EXTRACTED]
  scripts/replay-cdp.ts → src/server/types.ts

## Import Cycles
- None detected.

## Communities (103 total, 8 thin omitted)

### Community 0 - "CdpClient"
Cohesion: 0.06
Nodes (35): CDPTarget, discoverTargets(), main(), CDPTarget, main(), CDPTarget, main(), CDPTarget (+27 more)

### Community 1 - "server/types.ts"
Cohesion: 0.10
Nodes (26): extractionFunction(), MessageWrapperSelection, selectMessageWrappers(), AgentStatus, Approval, ApprovalAction, ChatTab, CodeBlockItem (+18 more)

### Community 2 - "ServerManager"
Cohesion: 0.06
Nodes (28): buildEnvFromConfig(), activate(), ensurePassword(), migrateTelegramBotToken(), LicenseManager, validateKey(), appendLogLine(), createLogOutputChannelWrapper() (+20 more)

### Community 3 - "Changelog"
Cohesion: 0.04
Nodes (46): [0.1.37] - 2026-03-21, [0.1.38] - 2026-03-22, [0.1.39] - 2026-03-24, [0.1.40] - 2026-03-24, [0.1.41] - 2026-03-24, [0.1.42] - 2026-03-27, [0.1.43] - 2026-04-06, [0.1.44] - 2026-04-07 (+38 more)

### Community 5 - "vendor-socket.io.min.js"
Cohesion: 0.09
Nodes (37): ALLOWED_EXACT, ALLOWED_PREFIXES, ALLOWED_ZIP_ROOT, DEV_ROOT, FORBIDDEN_PATTERNS, main(), PKG_PATH, REQUIRED_FILES (+29 more)

### Community 6 - "6. Implementation Discoveries"
Cohesion: 0.05
Nodes (37): 1. High-Level Overview, 2.1 CDP Client (`cdp-client.ts`), 2.2 CDP Bridge (`cdp-bridge.ts`), 2.3 DOM Extractor (`dom-extractor.ts`), 2.4 Command Executor (`command-executor.ts`), 2.5 State Manager (`state-manager.ts`), 2.6 Transport Layer, 2. Component Architecture (+29 more)

### Community 7 - "command-executor.ts"
Cohesion: 0.11
Nodes (9): MODEL_ITEM_COLLECTOR_JS, cloneNode(), El, makeDocument(), makeEl(), MockDoc, MockElement, parseHtml() (+1 more)

### Community 8 - "telegram-raw/index.ts"
Cohesion: 0.10
Nodes (14): BOT_COMMANDS, handleRegister(), RegisterDeps, grammyApiAdapter(), grammyCtxToBotCtx(), TelegramTransport, RawTelegramTransport, sleep() (+6 more)

### Community 9 - "commands.ts"
Cohesion: 0.18
Nodes (30): AuthState, RegisteredUser, ACTION_SELECTORS, CommandDeps, doDedupeInBackground(), doPurgeInBackground(), ensureTopicWindow(), genId() (+22 more)

### Community 10 - "cleanTabTitle"
Cohesion: 0.18
Nodes (7): cleanTabTitle(), doSyncInBackground(), makeRuntimeKey(), makeTitleKey(), normalizeWindowTitle(), TopicManager, TopicMapping

### Community 11 - "CursorRemote"
Cohesion: 0.17
Nodes (12): Accessing from another device, Bot Commands, CursorRemote, Documentation, Features, How It Works, Manual Setup, Privacy (+4 more)

### Community 12 - "4. State Model"
Cohesion: 0.17
Nodes (12): 4.10 Questionnaire, 4.11 QuestionnaireQuestion, 4.12 QuestionnaireOption, 4.1 CursorState (top-level), 4.2 AgentStatus, 4.4 ChatTab, 4.5 ModeInfo, 4.6 ModelInfo (+4 more)

### Community 13 - "Telegram Transport — Architecture Document"
Cohesion: 0.17
Nodes (12): 1. Component Overview, 2. Module Structure, 3.1 Outbound: Cursor → Telegram, 3.2 Inbound: Telegram → Cursor, 3. Data Flow, 5. Callback Data Encoding, 7.1 Telegram API Errors, 7.2 CDP Disconnection (+4 more)

### Community 14 - "publish.ts"
Cohesion: 0.14
Nodes (22): CHANGELOG_PATH, commitAndTag(), createGitHubRelease(), DEV_ROOT, devTreeClean(), ensureTag(), EXCLUDE, getChangelogSection() (+14 more)

### Community 15 - "relay.ts"
Cohesion: 0.15
Nodes (8): __dirname, __filename, RateLimitEntry, Relay, CommandPayload, createWebappSessionStore(), parseSessionCookie(), WebappSessionStore

### Community 16 - "base.ts"
Cohesion: 0.13
Nodes (31): activityLabelMatchesThoughtAction(), activityRedundantWithInProgressStepSummary(), cursorHtmlToTelegram(), escapeHtml(), formatActivity(), formatApprovals(), formatAssistant(), formatComposerQueue() (+23 more)

### Community 17 - "CDP Record/Replay Tools"
Cohesion: 0.10
Nodes (20): Architecture, Arguments, CDP Record/Replay Tools, Command, Command, Debugging a specific issue, Environment Variables, Example output (+12 more)

### Community 18 - "devDependencies"
Cohesion: 0.10
Nodes (21): esbuild, jsdom, devDependencies, esbuild, jsdom, tsx, @types/express, @types/jsdom (+13 more)

### Community 19 - "compilerOptions"
Cohesion: 0.10
Nodes (19): dist, compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution (+11 more)

### Community 20 - "MessageTracker"
Cohesion: 0.17
Nodes (3): MessageTracker, PersistedData, TrackedMessage

### Community 21 - "compilerOptions"
Cohesion: 0.11
Nodes (18): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, lib, module, outDir, resolveJsonModule (+10 more)

### Community 22 - "WindowMonitor"
Cohesion: 0.16
Nodes (5): approvalsFingerprint(), elementContentKey(), elementsSignature(), messageFingerprint(), WindowMonitor

### Community 23 - "2. User Stories"
Cohesion: 0.12
Nodes (16): 2. User Stories, US-10: Plan Widget Interaction, US-11: Shell Command Approval, US-12: Telegram Monitoring, US-13: Telegram Control, US-14: Agent Questionnaire, US-15: Telegram Auto-Sync, US-1: Remote Approval (+8 more)

### Community 24 - "scripts"
Cohesion: 0.12
Nodes (16): scripts, build, build:ext, dev, discover, package, probe, publish:public (+8 more)

### Community 25 - "CDPBridge"
Cohesion: 0.18
Nodes (5): CDPBridge, parseCdpTitle(), main(), CursorWindow, ServerConfig

### Community 26 - "dependencies"
Cohesion: 0.13
Nodes (15): dotenv, express, grammy, @grammyjs/auto-retry, node-html-parser, dependencies, dotenv, express (+7 more)

### Community 27 - "package.json"
Cohesion: 0.13
Nodes (14): activationEvents, description, displayName, engines, vscode, extensionKind, icon, main (+6 more)

### Community 28 - "release.ts"
Cohesion: 0.18
Nodes (12): [major, minor, patch], pkg, PKG_PATH, BumpType, bumpVersion(), CHANGELOG_PATH, main(), PKG_PATH (+4 more)

### Community 31 - "Topic Routing — Deep Analysis & Solution Plan"
Cohesion: 0.14
Nodes (13): 1. Cursor "Agent Unification" Architecture, 2. Current Scoping Logic (Fragile), 3. Window Title vs DOM, Evidence from telegram-topics.json, Files to Modify, Option A: Pass Window Title to Extraction (Recommended), Option B: Refuse Unscoped Tabs, Option C: Use Workspace Name from DOM (+5 more)

### Community 32 - "Telegram Connection Troubleshooting"
Cohesion: 0.15
Nodes (12): 1. Check the Logs, 2. Common Problems, 3. Grammy Hangs on Startup, 4. Bot Connects but Doesn't Respond to Commands, 5. Topics Not Created After `/sync`, 6. Still Stuck?, Another instance is polling, Bot token is invalid (+4 more)

### Community 33 - "web-client.test.ts"
Cohesion: 0.18
Nodes (6): APP_JS_PATH, EventHandler, fireFullState(), firePatch(), HTML_PATH, MockSocket

### Community 34 - "6. UI/UX Specification"
Cohesion: 0.17
Nodes (12): 6.10 Run Command Widget, 6.11 Native code blocks & diffs (`codeBlocks`, `diffBlock`, web UX), 6.1 Layout, 6.2 Chat Elements, 6.3 Approval Bar, 6.4 Message Input, 6.5 Window Picker, 6.6 Chat Tab Bar (+4 more)

### Community 35 - "2. User Stories"
Cohesion: 0.04
Nodes (49): 10. Success Criteria, 1.1 Problem Statement, 1.2 Goal, 1.3 Non-Goals, 1. Overview, 2. User Stories, 3.10 Ephemeral activity indicator, 3.11 Questionnaire (from state.questionnaire) (+41 more)

### Community 36 - "3. Message Format Specification"
Cohesion: 0.07
Nodes (15): buildSessionConfig(), ClientSecretResult, RealtimeBridge, fuzzyIncludes(), isMutatingTool(), MUTATING_TOOLS, PendingConfirmation, SessionSummary (+7 more)

### Community 37 - "server/index.ts"
Cohesion: 0.21
Nodes (7): CDPTarget, logStream, checkLicense(), LICENSE_PATH, readStoredKey(), validateKey(), Transport

### Community 38 - "SendQueue"
Cohesion: 0.21
Nodes (6): DEFAULT_CONFIG, Priority, QueueItem, SendQueue, SendQueueConfig, sleep()

### Community 39 - "2. User Stories"
Cohesion: 0.18
Nodes (11): 2. User Stories, US-10: Server Logs, US-1: Install and Go, US-2: Auto-Start, US-3: Settings UI, US-4: Setup Wizard, US-5: Status Visibility, US-6: Server Control (+3 more)

### Community 40 - "Secure Access with Tailscale"
Cohesion: 0.18
Nodes (11): 2. Install Tailscale on Your Phone, 3. Access the Web App, 4. Lock Down to Tailscale Only, 5. Tailscale + Password (Defense in Depth), 6. Tailscale Funnel (Temporary Public Access), "Connection refused" on phone, MagicDNS not resolving, Secure Access with Tailscale (+3 more)

### Community 41 - "DOMExtractor"
Cohesion: 0.30
Nodes (11): activityFromThoughtTail(), applyDerivedActivityToState(), collapsibleHeaderTextLooksComplete(), deriveActivityFromSignals(), DerivedActivityState, getLastLoadingTool(), hasLiveLoadingIndicator(), looksFinishedActivity() (+3 more)

### Community 43 - "CursorRemote — Extension PRD"
Cohesion: 0.20
Nodes (10): 10. Getting Started Walkthrough, 13. Backward Compatibility, 3.1 Singleton Server Pattern, 3. Architecture, 4. Extension Commands, 5.1 Security Defaults, 5. Extension Settings, 6. Status Bar (+2 more)

### Community 44 - "11. Server-Side Enhancements"
Cohesion: 0.20
Nodes (10): 11.1 Richer `/health` endpoint, 11.2 `LICENSE_KEY` env var, 11.3 `DATA_DIR` env var, 11.4 `LOG_FORMAT` env var, 11.5 Cache-busting static serving, 11.6 Auth middleware ordering, 11.7 grammY native fetch, 11.8 Graceful Telegram shutdown (+2 more)

### Community 45 - "CursorRemote — Product Requirements Document"
Cohesion: 0.15
Nodes (13): 10.1 Custom CDP Client vs. Puppeteer, 10.2 CDP Input Domain for Text Entry, 10.3 Data-Attribute Extraction vs. Class-Based Selectors, 10. Key Technical Decisions, 11. Implementation Status, 12. Risks & Mitigations, 13. Future Roadmap, 14. Success Criteria (+5 more)

### Community 46 - "2A. Extension Setup (Recommended)"
Cohesion: 0.22
Nodes (9): 2A. Extension Setup (Recommended), Install, License Key, Multi-Window Behavior, Networking and Password, Server Lifecycle, Telegram (Extension), Web client — code and diffs (+1 more)

### Community 47 - "4. Telegram Integration (Optional)"
Cohesion: 0.22
Nodes (9): 4.1 Create the Bot, 4.2 Configure, 4.3 Start the Server, 4.4 Set Up the Group, 4.5 Register and Sync, 4.6 Bot Commands, 4.7 How It Works, 4.8 Authentication (+1 more)

### Community 48 - "Telegram Transport Module — Product Requirements Document"
Cohesion: 0.24
Nodes (12): buildSelectorArgs(), CDPTarget, discoverTargets(), getAppVersion(), hashSelectors(), main(), normalizeVolatileIds(), RecordingHeader (+4 more)

### Community 49 - "enum"
Cohesion: 0.22
Nodes (9): default, enum, markdownDescription, type, cursorRemote.logLevel, debug, error, info (+1 more)

### Community 50 - "3. Network Access"
Cohesion: 0.25
Nodes (8): 3. Network Access, Default: Localhost Only, LAN Access, Option A: Mirrored Networking (Recommended), Option B: Port Forwarding, Secure Remote Access, Windows Firewall, WSL2-Specific

### Community 51 - "dev-wrapper.ts"
Cohesion: 0.43
Nodes (7): ensureLicense(), LICENSE_PATH, main(), promptKey(), readStoredKey(), saveKey(), validateKey()

### Community 52 - "plan-files.ts"
Cohesion: 0.43
Nodes (7): escapeHtml(), inlineMarkdown(), markdownToWebHtml(), parsePlanMd(), PlanFileData, readPlanFile(), PlanTodo

### Community 53 - "Setup Guide -- CursorRemote"
Cohesion: 0.29
Nodes (7): 2B. Standalone Setup (Without Extension), 5. Production (Standalone), Install, Option A: tmux, Option B: Compiled, Setup Guide -- CursorRemote, Start the Server

### Community 54 - "properties"
Cohesion: 0.29
Nodes (7): properties, title, configuration, default, markdownDescription, type, cursorRemote.webappPassword

### Community 55 - "contributes"
Cohesion: 0.29
Nodes (7): contributes, commands, views, viewsContainers, walkthroughs, cursorRemote, activitybar

### Community 56 - "cursorRemote.telegram.impl"
Cohesion: 0.29
Nodes (7): default, enum, markdownDescription, type, cursorRemote.telegram.impl, grammy, raw

### Community 57 - "app.js"
Cohesion: 0.62
Nodes (6): bootstrap(), checkAuth(), getAuthHeaders(), getAuthToken(), init(), newCommandId()

### Community 58 - "CLAUDE.md"
Cohesion: 0.33
Nodes (4): Architecture Overview, Commands, Key Documentation, What This Is

### Community 60 - "12. Build and Distribution"
Cohesion: 0.33
Nodes (6): 12.1 Extension Build, 12.2 Server Build, 12.3 Client Build, 12.4 Packaging, 12.5 Version Bumping, 12. Build and Distribution

### Community 61 - "1. Enable CDP on Cursor IDE"
Cohesion: 0.33
Nodes (6): 1. Enable CDP on Cursor IDE, Important, Linux, macOS, Verify, Windows: Shortcut (Recommended)

### Community 62 - "Standalone-Specific"
Cohesion: 0.33
Nodes (6): Bot doesn't respond, Build doesn't work on macOS, Server log, Standalone-Specific, /sync says "missing permissions", /sync says "not a supergroup" or "not a forum"

### Community 63 - "General"
Cohesion: 0.33
Nodes (6): "Disconnected" in web UI, General, macOS: Cursor backgrounds and the phone stops updating, "No valid license key" or server exits immediately, Older mobile browser shows a blank or broken UI, Phone/tablet can't connect

### Community 64 - "Pre-Release Smoke Checklist"
Cohesion: 0.33
Nodes (5): Edge Cases, Environment, Pre-Release Smoke Checklist, Telegram, Web App

### Community 65 - "8. Edge Cases"
Cohesion: 0.23
Nodes (10): contentHash(), elapsed(), main(), RecordLine, RecordLineV1, RecordLineV2, stripHtml(), FormattedMessage (+2 more)

### Community 66 - "8. Setup Panel (WebviewPanel)"
Cohesion: 0.40
Nodes (5): 8. Setup Panel (WebviewPanel), Footer, Networking Tab, Password Section, Telegram Tab

### Community 67 - "7. DOM Extraction Strategy"
Cohesion: 0.40
Nodes (5): 7.1 Challenge, 7.2 Approach — Data-Attribute-Driven Extraction, 7.3 Discovery Tool, 7.4 Polling & Diffing, 7. DOM Extraction Strategy

### Community 68 - "6. Troubleshooting"
Cohesion: 0.40
Nodes (5): 6. Troubleshooting, Extension-Specific, Multiple Cursor windows, Server shows "Disconnected" in the sidebar, Telegram bot doesn't respond

### Community 69 - "1. Install Tailscale on the Server"
Cohesion: 0.40
Nodes (5): 1. Install Tailscale on the Server, Linux / WSL2, macOS, Verify, Windows 11

### Community 70 - "5. Topic Mapping"
Cohesion: 0.35
Nodes (7): buildDigestPrompt(), DigestClient, DigestClientOptions, elementsToDigestLines(), fallbackDigest(), sanitizeForSpeech(), ChatElement

### Community 71 - "7. Rate Limiting and Constraints"
Cohesion: 0.18
Nodes (11): 4.3 ChatElement (discriminated union), AssistantMessage (`type: 'assistant'`), HumanMessage (`type: 'human'`), LoadingIndicator (`type: 'loading'`), PlanAction (sub-type of PlanBlock), PlanBlock (`type: 'plan'`), PlanTodo (sub-type of PlanBlock), RunAction (sub-type of RunCommand) (+3 more)

### Community 72 - "esbuild.js"
Cohesion: 0.50
Nodes (4): main(), production, shared, watch

### Community 73 - "normalize-fixture.ts"
Cohesion: 0.60
Nodes (4): main(), normalizeIds(), SnapshotLine, stripMachineFields()

### Community 74 - "1. Overview"
Cohesion: 0.50
Nodes (4): 1.1 Problem Statement, 1.2 Goals, 1.3 Non-Goals, 1. Overview

### Community 75 - "7. Sidebar Tree View"
Cohesion: 0.50
Nodes (4): 7. Sidebar Tree View, When licensed, server running:, When licensed, server stopped:, When unlicensed:

### Community 77 - "1. Overview"
Cohesion: 0.50
Nodes (4): 1.1 Problem Statement, 1.2 Goal, 1.3 Non-Goals, 1. Overview

### Community 78 - "3. System Architecture"
Cohesion: 0.50
Nodes (4): 3.0 Transport Architecture, 3.1 Data Flow — Observation, 3.2 Data Flow — Commands, 3. System Architecture

### Community 79 - "9. Technical Requirements"
Cohesion: 0.50
Nodes (4): 9.1 Server, 9.2 Client, 9.3 Host Environment, 9. Technical Requirements

### Community 80 - "Chrome DevTools Protocol (CDP)"
Cohesion: 0.50
Nodes (3): Chrome DevTools Protocol (CDP), CursorRemote sidebar, Launch Cursor with CDP enabled

### Community 81 - "Network Access"
Cohesion: 0.50
Nodes (3): Network Access, Option 1 — Same LAN, Option 2 — Tailscale (recommended)

### Community 82 - "cursorRemote.autoStart"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.autoStart

### Community 83 - "cursorRemote.cdpUrl"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.cdpUrl

### Community 84 - "cursorRemote.debounceMs"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.debounceMs

### Community 85 - "cursorRemote.pollIntervalMs"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.pollIntervalMs

### Community 86 - "cursorRemote.serverHost"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.serverHost

### Community 87 - "cursorRemote.serverPort"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.serverPort

### Community 88 - "cursorRemote.telegram.allowedUsers"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.telegram.allowedUsers

### Community 89 - "cursorRemote.telegram.botToken"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.telegram.botToken

### Community 90 - "cursorRemote.telegram.enabled"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.telegram.enabled

### Community 91 - "cursorRemote.windowTitleQualifier"
Cohesion: 0.50
Nodes (4): default, markdownDescription, type, cursorRemote.windowTitleQualifier

### Community 94 - "categories"
Cohesion: 0.67
Nodes (3): categories, Machine Learning, Other

### Community 95 - "repository"
Cohesion: 0.67
Nodes (3): repository, type, url

### Community 99 - "Setup A: Extension (Recommended)"
Cohesion: 0.25
Nodes (8): 1. Install the Extension, 2. Enter Your License Key, 3. Launch Cursor with CDP Enabled, 4. Server Auto-Starts, 5. Configure Networking and Connect, Extension Commands, Extension Settings, Setup A: Extension (Recommended)

### Community 100 - "4. Component Details"
Cohesion: 0.33
Nodes (6): 4.1 TelegramTransport (`index.ts`), 4.2 Formatter (`formatter.ts`), 4.3 TopicManager (`topic-manager.ts`), 4.4 MessageTracker (`message-tracker.ts`), 4.5 Commands (`commands.ts`), 4. Component Details

### Community 101 - "Setup B: Standalone Server (Without Extension)"
Cohesion: 0.40
Nodes (5): Install and Run, Prerequisites, Production, Setup B: Standalone Server (Without Extension), Standalone Configuration

### Community 102 - "6. Message Lifecycle"
Cohesion: 0.50
Nodes (4): 6.1 New Element Appears, 6.2 Element Content Changes (Streaming), 6.3 Approval Resolved, 6. Message Lifecycle

## Knowledge Gaps
- **563 isolated node(s):** `production`, `shared`, `JsonLogLine`, `TelegramAuth`, `PanelState` (+558 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `properties` connect `properties` to `cursorRemote.telegram.impl`, `enum`, `cursorRemote.autoStart`, `cursorRemote.cdpUrl`, `cursorRemote.debounceMs`, `cursorRemote.pollIntervalMs`, `cursorRemote.serverHost`, `cursorRemote.serverPort`, `cursorRemote.telegram.allowedUsers`, `cursorRemote.telegram.botToken`, `cursorRemote.telegram.enabled`, `cursorRemote.windowTitleQualifier`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._
- **Why does `grammy` connect `cursorRemote.telegram.impl` to `telegram-raw/index.ts`, `8. Edge Cases`?**
  _High betweenness centrality (0.116) - this node is a cross-community bridge._
- **What connects `production`, `shared`, `JsonLogLine` to the rest of the system?**
  _563 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `CdpClient` be split into smaller, more focused modules?**
  _Cohesion score 0.056633663366336635 - nodes in this community are weakly interconnected._
- **Should `server/types.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09747899159663866 - nodes in this community are weakly interconnected._
- **Should `ServerManager` be split into smaller, more focused modules?**
  _Cohesion score 0.06296296296296296 - nodes in this community are weakly interconnected._
- **Should `Changelog` be split into smaller, more focused modules?**
  _Cohesion score 0.0425531914893617 - nodes in this community are weakly interconnected._