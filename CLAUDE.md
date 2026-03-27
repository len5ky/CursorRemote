# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

CursorRemote — a VS Code/Cursor extension + Node.js relay server that connects to Cursor IDE via Chrome DevTools Protocol (CDP), extracts agent chat state from the DOM, and streams it to a mobile web client (socket.io) and/or Telegram bot. Users monitor and control their Cursor AI agent remotely.

## Key Documentation

Read before making changes:
- `docs/prd.md` — product requirements, state model, protocol
- `docs/architecture.md` — component design, data flow, technical decisions
- `docs/extension_prd.md` — VS Code extension features, settings, build
- `.cursor/rules/project.mdc` — **comprehensive project conventions** (TypeScript, CDP patterns, DOM extraction, state management, socket.io protocol, client conventions, error handling, file organization, versioning). This is the primary source of coding rules.
- `.cursor/rules/probe-before-parsing.mdc` — always probe live systems for direct data before building parsing heuristics
- `.cursor/rules/publish.mdc` — two-repo publishing workflow (dev → public)
- `.cursor/skills/release/SKILL.md` — release process skill

## Commands

```bash
npm run dev          # Development with hot-reload (tsx watch)
npm run build        # TypeScript compile + copy client assets
npm run build:ext    # Bundle VS Code extension (esbuild)
npm run watch:ext    # Watch-mode for extension dev
npm start            # Run compiled server
npm test             # Run tests: npx tsx --test tests/*.test.ts
npm run package      # Bump patch + package .vsix into releases/
npm run release -- patch|minor|major  # Bump version, changelog, git tag
npm run discover     # DOM discovery tool against live Cursor
```

## Architecture Overview

```
extension/          VS Code extension (separate TS project, esbuild bundle)
  └─ src/           Extension code — imports vscode only, never src/server/
                    Communicates with server via: env vars, HTTP /health, stdout parsing

src/server/         Node.js relay server (ESM, strict TypeScript)
  index.ts          Composition root — wires modules, no business logic
  cdp-client.ts     Lightweight CDP WebSocket client (NOT Puppeteer)
  cdp-bridge.ts     Discovers all Cursor window targets, holds CdpClient refs
  window-monitor.ts Polls all windows in parallel via separate CDP connections
  dom-extractor.ts  Runs inside Cursor's browser context via Runtime.evaluate
  state-manager.ts  EventEmitter — emits state:patch, connection:changed
  command-executor.ts  Handles commands from web/Telegram clients
  relay.ts          Express + socket.io server
  config.ts         Single source for all configuration (reads env vars)
  types.ts          Shared types — import from here, don't redeclare
  transports/       Telegram bot transport
    telegram/       Grammy-based bot with forum topic auto-creation

src/client/         Vanilla HTML/CSS/JS web client (no build step, served as static)
  app.js            Mobile-first UI, socket.io for real-time updates

src/discovery/      CDP DOM discovery/debugging tools
```

Key architectural patterns:
- **Modules communicate via EventEmitter**, not direct imports. Wiring happens in `index.ts`.
- **DOM selectors** for non-message elements come from `selectors.json` (loaded via config), never hardcoded.
- **Message extraction** uses Cursor's `data-*` attributes (`data-flat-index`, `data-message-role`, etc.).
- **Extension ↔ Server boundary**: the extension spawns the server as a child process. License validation is intentionally duplicated between `extension/src/license-manager.ts` and `src/server/license.ts`.
- **Two repos**: this dev repo (`~/Dev/cursor-ide-remote/`) and public repo (`~/Dev/CursorRemote/`). Publishing uses `npm run publish:public`.
