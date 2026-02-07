# Claude Code Project Notes

Project-specific hints for Claude Code sessions.

## Git Operations

This project runs inside tmux where SSH agent may not be available. Use GNOME keyring socket:

```bash
SSH_AUTH_SOCK=/run/user/1000/gcr/ssh git push
```

## Project Structure

- `bridge.js` - Main Slack bot using Socket Mode
- `slack-notify.sh` - Hook script called by Claude Code on events
- `slack-forward-prompt.sh` - Forwards local prompts to Slack
- `slack-read-thread.sh` - Read current Slack thread history
- `slack-claude.sh` - Start sessions from local machine (symlinked to ~/.local/bin/)
- `slack-upload.sh` - Upload files to Slack threads
- `slack-claude-start.sh` - Start the bridge (symlinked to ~/.local/bin/)
- `slack-bridge.md` - Global rules (symlinked to ~/.claude/rules/)
- `slack-bridge.service` - systemd user service for autostart (symlinked to ~/.config/systemd/user/)

## Testing Changes

After modifying `bridge.js`, restart the bridge:
```bash
slack-claude-start --restart
```

After modifying hook scripts (`slack-notify.sh`, etc.), changes take effect immediately (no restart needed).

## Runtime Files

| File | Purpose |
|------|---------|
| `/tmp/claude-slack-sessions.json` | Session tracking (thread → window mapping) |
| `/tmp/claude-slack-files/<threadTs>/` | Downloaded file attachments |

Thread context is detected via `CLAUDE_THREAD_TS` env var or tmux window lookup in sessions.json.

## Adding New Tools

1. Create executable scripts in this directory (`slack-bridge/`)
2. Symlink from `~/.claude/` to here: `ln -s ~/.claude/slack-bridge/script.sh ~/.claude/script.sh`
3. Document in this CLAUDE.md or relevant SPEC file
4. Ensure proper error handling and usage messages
