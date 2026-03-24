# CDP Record/Replay Tools

Standalone tools for capturing Cursor IDE state over time and replaying it to a Telegram test topic. Designed for debugging the Telegram transport pipeline without running the full relay.

## Why

Cursor's agent UI is animated -- elements appear, shimmer, transition between states, and get replaced. The relay must translate these transitions into correct Telegram API calls (send, edit, delete). Bugs in this translation are hard to reproduce because they depend on specific DOM state sequences that happen during live agent sessions.

These tools solve that by letting you:
1. **Record** a live session as a sequence of CursorState snapshots
2. **Replay** that recording to a test Telegram topic, seeing exactly what the relay would send
3. **Iterate** on formatter/transport code and replay the same recording to verify fixes

## Architecture

```
Record:  CDP -> extractionFunction -> CursorState -> JSONL file
Replay:  JSONL file -> formatter -> Telegram test topic + stdout log
```

Both scripts are standalone processes. They import shared code from `src/` as libraries but do not modify any relay source files. The relay can run simultaneously without interference.

## Prerequisites

- Cursor IDE running with `--remote-debugging-port=9222`
- `.env` file with `TELEGRAM_BOT_TOKEN` (for replay)
- A Telegram supergroup with forum topics enabled

## Recording

### Command

```bash
npm run record                            # record first Cursor window
npm run record -- --window cursor-ide     # match window by title substring
```

### What it does

1. Connects to CDP at `http://127.0.0.1:9222` (override with `CDP_URL` env var)
2. Discovers all Cursor windows, connects to the matching one
3. Runs the same `extractionFunction` the relay uses, every 300ms
4. Writes state snapshots to `data/recording-<timestamp>.jsonl`
5. Deduplicates: only writes when state actually changes (keeps files small)
6. Shows live progress on stdout

### Output format

Each line is a JSON object:

```json
{"ts":1711234567890,"state":{"connected":true,"agentStatus":"generating","agentActivityText":"Planning next moves","messages":[...],...}}
```

- `ts` -- epoch milliseconds when the snapshot was captured
- `state` -- full `CursorState` object (or `null` if extraction failed)

### Tips

- Record while the agent is actively working for interesting state transitions
- Recordings are typically 10-200 KB for a few minutes of activity
- Press Ctrl+C to stop recording cleanly

## Replaying

### Command

```bash
npm run replay -- <recording.jsonl> --thread <topic_id> [--chat <group_id>] [--speed N]
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `<file>` | Yes | Path to a `.jsonl` recording |
| `--thread` | Yes | Telegram forum topic `message_thread_id` to send to |
| `--chat` | No | Telegram group chat ID (default: `TELEGRAM_CHAT_ID` env) |
| `--speed` | No | Playback speed multiplier (default: 5) |

### What it does

1. Reads all snapshots from the recording
2. For each state transition, at the recorded pace (scaled by `--speed`):
   - **Activity indicator**: sends, edits, or deletes an ephemeral activity message (derived from `_rawSignals` via `deriveActivityFromSignals` when present, else `agentActivityText`). The live relay’s `TelegramTransport` additionally **dedupes** activity against in-flight `📎` step-summary thoughts (`activityRedundantWithInProgressStepSummary`); the replay script does not yet mirror that dedup — recordings may still show both lines if the snapshot order matches that edge case.
   - **Content messages**: sends new chat elements, edits existing ones when content changes (`formatElement`; tool messages may include evolving fields such as `diffBlock` / `codeBlocks` if present in the recording)
3. Logs every Telegram API call to stdout

### Example output

```
[replay] Loaded 47 snapshots from data/recording-2026-03-24T00-24-00.jsonl
[replay] Speed: 10x, thread: 12345, chat: -1001234567890

[replay] Bot: @cursor_controller_bot

[+0.1s] SEND  activity "Planning next moves" -> msgId=100
[+0.4s] SEND  human "fix the bug in config.ts" -> msgId=101
[+0.8s] EDIT  activity msgId=100 "Generating"
[+1.2s] DELETE activity msgId=100
[+1.3s] SEND  tool "Edit config.ts  +14 -7" -> msgId=102
[+1.5s] SEND  assistant "I've fixed the configuration issue..." -> msgId=103
[+2.0s] EDIT  tool msgId=102 "Edit config.ts  +14 -7"

[replay] Done -- 4 content messages, 47 snapshots replayed
```

### Finding the thread ID

To get a forum topic's `message_thread_id`:
1. Forward any message from the topic to [@RawDataBot](https://t.me/RawDataBot)
2. Look for `message_thread_id` in the response
3. Or check the topic URL -- in `https://t.me/c/1234567890/42`, the thread ID is `42`

### Finding the chat ID

The group chat ID (negative number like `-1001234567890`):
1. Forward any message from the group to [@RawDataBot](https://t.me/RawDataBot)
2. Look for `chat.id` in the response
3. Or set `TELEGRAM_CHAT_ID` in your `.env`

## Workflow

### Debugging a specific issue

```bash
# 1. Start recording while reproducing the issue
npm run record -- --window cursor-ide

# 2. Do the thing in Cursor that triggers the bug
#    (e.g. start an agent task, wait for activity indicators)

# 3. Stop recording (Ctrl+C)

# 4. Create a test topic in your Telegram group

# 5. Replay to see what the relay would send
npm run replay -- data/recording-2026-03-24T00-24-00.jsonl --thread 99999 --speed 5

# 6. Check the test topic in Telegram -- does it look right?

# 7. Fix the code, replay the same recording, compare
npm run replay -- data/recording-2026-03-24T00-24-00.jsonl --thread 99999 --speed 5
```

### Regression testing

Keep recordings of known scenarios in the repo (or a shared folder). After making changes to the formatter or transport logic, replay them and verify the output hasn't regressed.

## Environment Variables

| Variable | Used by | Default | Description |
|----------|---------|---------|-------------|
| `CDP_URL` | record | `http://127.0.0.1:9222` | Chrome DevTools Protocol endpoint |
| `TELEGRAM_BOT_TOKEN` | replay | -- | Bot token (required) |
| `TELEGRAM_CHAT_ID` | replay | -- | Default group chat ID |
| `SELECTORS_PATH` | record | `./selectors.json` | Custom selectors file |
