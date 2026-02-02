# Slack Integration

When running in a slack-bridge managed tmux session, these tools are available for communicating with the Slack thread.

## Upload Files to Slack

```bash
~/.claude/slack-upload.sh <file_path> [message]
```

Examples:
```bash
~/.claude/slack-upload.sh ./screenshot.png "Here's the screenshot"
~/.claude/slack-upload.sh ./output.csv
~/.claude/slack-upload.sh /tmp/debug.log "Debug output attached"
```

## Read Slack Thread History

```bash
~/.claude/slack-read-thread.sh
```

Returns timestamped messages from the current thread.

## Thread Detection

Thread context is automatically detected from:
1. `CLAUDE_THREAD_TS` environment variable
2. Current tmux window name (fallback)
