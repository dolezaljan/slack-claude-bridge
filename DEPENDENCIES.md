# Installation & Dependencies

All scripts live in this directory (`~/.claude/slack-bridge/`) and are symlinked for global access.

## Symlinks Created by install.sh

| Source (slack-bridge/) | Symlink |
|------------------------|---------|
| `slack-notify.sh` | `~/.claude/slack-notify.sh` |
| `slack-forward-prompt.sh` | `~/.claude/slack-forward-prompt.sh` |
| `slack-read-thread.sh` | `~/.claude/slack-read-thread.sh` |
| `slack-upload.sh` | `~/.claude/slack-upload.sh` |
| `slack-claude.sh` | `~/.local/bin/slack-claude` |
| `slack-claude-start.sh` | `~/.local/bin/slack-claude-start` |
| `slack-bridge.md` | `~/.claude/rules/slack-bridge.md` |

## Documentation

| File | Purpose |
|------|---------|
| `README.md` | User-facing setup and usage guide |
| `INTERNALS.md` | Implementation details for developers |

## Configuration

| File | Purpose |
|------|---------|
| `~/.claude/settings.json` | Claude Code hooks configuration |
| `config.json` | Bot tokens and allowed users (not in git) |

## Hooks Configuration

From `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "command": "~/.claude/slack-forward-prompt.sh" }] }
    ],
    "Notification": [
      { "matcher": "idle_prompt", "hooks": [{ "command": "~/.claude/slack-notify.sh" }] },
      { "matcher": "permission_prompt", "hooks": [{ "command": "~/.claude/slack-notify.sh" }] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [{ "command": "~/.claude/slack-notify.sh" }] }
    ]
  }
}
```

## Runtime Files

| File | Purpose |
|------|---------|
| `/tmp/claude-slack-sessions.json` | Session tracking (thread → window mapping) |
| `/tmp/claude-slack-sessions.lock` | File lock for sessions.json |
| `/tmp/slack-bridge.log` | Bridge log file |
| `/tmp/claude-slack-files/<threadTs>/` | Downloaded file attachments |
| `/tmp/claude-slack-pending-<threadTs>` | Pending message hash (deduplication) |
| `/tmp/claude-slack-last-sent-hash-<session>` | Last sent message hash (deduplication) |
| `/tmp/claude-slack-last-sent-time-<session>` | Last sent message time |
| `/tmp/claude-slack-dm-cache-<channel>` | DM channel cache |
| `/tmp/claude-slack-bridge-<hash>.lock` | Instance lock (prevents duplicate bridges) |
