# External Dependencies

Files outside `~/.claude/slack-bridge/` that are part of the Slack integration.

## Hook Scripts

These scripts are called by Claude Code hooks (configured in `~/.claude/settings.json`):

| File | Purpose |
|------|---------|
| `~/.claude/slack-notify.sh` | Sends Claude responses/notifications to Slack |
| `~/.claude/slack-read-thread.sh` | Reads Slack thread history (for context) |
| `~/.claude/slack-share-file.sh` | Shares files/screenshots to Slack |

## Startup

| File | Purpose |
|------|---------|
| `~/.claude/claude-slack-start.sh` | Bootstrap script to start tmux + bridge + Claude |

## Documentation

| File | Purpose |
|------|---------|
| `~/.claude/SPEC-slack-bridge.md` | Original single-session spec |
| `~/.claude/SPEC-slack-multi-session.md` | Multi-session spec (to be implemented) |
| `~/.claude/TOOLS.md` | Index of available tools |

## Configuration

| File | Purpose |
|------|---------|
| `~/.claude/settings.json` | Claude Code hooks configuration |
| `~/.claude/slack-bridge/config.json` | Bot tokens and allowed users (not in git) |

## Hooks Configuration

From `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      { "matcher": "idle_prompt", "hooks": [{ "command": "slack-notify.sh" }] },
      { "matcher": "permission_prompt", "hooks": [{ "command": "slack-notify.sh" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "command": "slack-notify.sh" }] }
    ]
  }
}
```

## Runtime Files

| File | Purpose |
|------|---------|
| `/tmp/claude-slack-thread-context.json` | Current thread context for hooks |
| `/tmp/claude-slack-sessions.json` | Session tracking (multi-session) |
| `/tmp/claude-slack-sessions.lock` | File lock for sessions.json |
