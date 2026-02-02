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
| `/tmp/claude-slack-thread-context.json` | Current thread context for hooks |
| `/tmp/claude-slack-sessions.json` | Session tracking (multi-session) |
| `/tmp/claude-slack-sessions.lock` | File lock for sessions.json |
| `/tmp/slack-bridge.log` | Bridge log file |
