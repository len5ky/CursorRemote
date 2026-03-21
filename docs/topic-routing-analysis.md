# Topic Routing — Deep Analysis & Solution Plan

## Problem Summary

Topics are created with wrong (window, tab) pairs:
- `cursor-ide-remote — Campaign results improvement plan` (should be adwords)
- `adwords-optimization-agent — VNC setup on Ubuntu machine` (should be .openclaw)

## Evidence from telegram-topics.json

```
adwords (C25284...) — "Campaign results improvement plan" ✓ correct
adwords (C25284...) — "VNC setup on Ubuntu machine"       ✗ wrong (belongs to .openclaw)
cursor-ide-remote (EAF88...) — "Campaign results improvement plan" ✗ wrong (belongs to adwords)
```

Same tab titles appear under wrong windows.

## Root Cause Analysis

### 1. Cursor "Agent Unification" Architecture

When `body.agent-unification-enabled`, the sidebar shows **all projects** in one view:
- `.agent-sidebar-project-cell` per project (adwords, cursor-ide-remote, .openclaw, etc.)
- `.agent-sidebar-cell` (chat tabs) nested under each project

When we connect to window X via CDP, we get that window's DOM. But the DOM may show the **unified sidebar** with all projects. So we can see tabs from other projects.

### 2. Current Scoping Logic (Fragile)

We scope by `containerComposerId`:
1. Get composer-id from the chat container (messages)
2. Find the tab whose composer-id matches
3. Get that tab's ancestor `.agent-sidebar-project-cell`
4. Only return tabs inside that project cell

**Failure modes:**
- `containerComposerId` empty → scopeRoot = null → we use `document` → get ALL tabs from all projects
- No cell matches (composer-id on tab vs container mismatch) → same fallback
- `.agent-sidebar-project-cell` not found (DOM structure changed) → we use `document.body` → wrong scope

### 3. Window Title vs DOM

The CDP window title (e.g. "cursor-ide-remote [WSL: ubuntu-24.04]") is the **authoritative** source for which project we're in. The DOM may show multiple projects. We must scope tabs by matching the **window title** to the project cell label in the DOM.

## Solution Plan

### Option A: Pass Window Title to Extraction (Recommended)

1. **Add `windowTitle` parameter** to `extractionFunction`
2. **Callers**: WindowMonitor passes `win.title` when polling; main DOM extractor gets it from `cdpBridge.windows` + `activeTargetId`
3. **Scope logic**: Find `.agent-sidebar-project-cell` whose label/text contains or matches `windowTitle` (normalized). Only return tabs from that cell.
4. **Fallback**: If no matching project cell, return **empty chatTabs** — never use unscoped tabs.

### Option B: Refuse Unscoped Tabs

1. When `scopeRoot` is null (can't scope by composer-id), return `chatTabs: []`
2. Prevents wrong topic creation when scoping fails
3. May cause "no sync" for some windows until we fix scoping

### Option C: Use Workspace Name from DOM

1. Read `.agent-sidebar-workspace-name` or `.auxiliary-bar-workspace-name` — shows current workspace
2. Use that to find the matching project cell
3. No need to pass window title from outside

## Recommended Implementation

**Combine A + B:**
1. Pass `windowTitle` to extraction (from snapshot/window when polling)
2. Primary scope: find project cell matching window title
3. Fallback: try composer-id scoping
4. If both fail: return empty chatTabs (safe failure)

## Files to Modify

- `dom-extractor.ts`: Add windowTitle param, implement project-cell matching by title, empty chatTabs on failure
- `window-monitor.ts`: Pass win.title to extractFromClient
- `dom-extractor.ts` (DOMExtractor class): Pass window title from bridge state when polling
- `index.ts` or extractor setup: Wire window title into main poll
