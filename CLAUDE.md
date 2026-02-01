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
- `slack-claude.sh` - Start sessions from local machine
- `slack-upload.sh` - Upload files to Slack threads

## Testing Changes

After modifying `bridge.js`, restart the bridge:
```bash
tmux send-keys -t claude:bridge C-c
tmux send-keys -t claude:bridge 'npm start' Enter
```

After modifying hook scripts (`slack-notify.sh`, etc.), changes take effect immediately (no restart needed).
