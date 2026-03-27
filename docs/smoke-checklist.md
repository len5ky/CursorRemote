# Pre-Release Smoke Checklist

Run these manual checks after automated tests pass and before publishing a release.

## Environment

- [ ] Install packaged VSIX on a clean machine or profile (not the development checkout)
- [ ] Confirm server starts and prints `=== CursorRemote vX.Y.Z ===` with correct version

## Web App

- [ ] Web app loads in browser — no console errors for `io`, `vendor-socket.io.min.js`
- [ ] Favicon loads (no 404)
- [ ] Login / session persistence works (reload keeps session)
- [ ] Connection dot shows "Connected" when Cursor is active
- [ ] Agent status shows shimmer text during activity, returns to "Idle" when done
- [ ] Messages render with correct types (human, assistant, tool, thought)
- [ ] Run command card shows command text, Skip/Run buttons
- [ ] After approval, approval buttons disappear and tool result appears
- [ ] Plan widget shows title, progress, "View Plan" opens modal with full plan
- [ ] Plan model picker opens sheet with model options
- [ ] Code blocks preserve newlines, diffs show red/green coloring
- [ ] Scrolling up stops auto-scroll; new messages don't snap back down

## Telegram

- [ ] Live activity shows shimmer (spoiler tag) — e.g. `● Thinking…` with spoiler
- [ ] Shimmer disappears when activity finishes (message deleted)
- [ ] Thought step-summaries show spoiler while in progress, remove when completed
- [ ] Activity line is deduplicated against matching step-summary
- [ ] Run command shows command text with Skip/Run inline buttons
- [ ] Plan block renders with todos and View Plan / Build buttons

## Edge Cases

- [ ] Switching between multiple Cursor windows shows correct state per window
- [ ] Backgrounding Cursor (macOS) gracefully degrades — no crash, status shows stale
- [ ] Rapidly switching tabs doesn't cause duplicate messages
