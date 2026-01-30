# Claude Code Slack Bridge

Bidirectional bridge between Slack and Claude Code. Send messages to Claude via Slack DM or @mentions, receive notifications when Claude needs input.

## Architecture

```
You (Slack) → Socket Mode → bridge.js → tmux send-keys → Claude Code
Claude Code → slack-notify.sh → Bot API → Slack → You
```

All communication uses a single Slack Bot Token - no webhooks needed.

## Setup

### 1. Create Slack App

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it "Claude Code" and select your workspace

### 2. Configure Bot Token Scopes

Go to **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:
- `chat:write` - Send messages
- `channels:history` - Read channel messages (for @mentions)
- `im:history` - Read DMs
- `im:read` - Access DM info
- `reactions:write` - Add reactions
- `app_mentions:read` - Receive @mentions

### 3. Enable Socket Mode

1. Go to **Socket Mode** → Enable
2. Create an **App-Level Token** with `connections:write` scope
3. Copy the token (starts with `xapp-`)

### 4. Install App to Workspace

1. Go to **Install App** → Install to Workspace
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 5. Get Your User ID

In Slack, click your profile → **⋮** → **Copy member ID**

### 6. Configure the Bridge

```bash
cd ~/.claude/slack-bridge
cp config.example.json config.json
```

Edit `config.json`:
```json
{
  "botToken": "xoxb-your-bot-token",
  "appToken": "xapp-your-app-level-token",
  "allowedUsers": ["U12345678"],
  "notifyChannel": "#claude-notifications"
}
```

- `botToken` - Bot User OAuth Token from step 4
- `appToken` - App-Level Token from step 3
- `allowedUsers` - Your Slack user ID(s) from step 5
- `notifyChannel` - Channel or DM for notifications (use your user ID for DMs: `"U12345678"`)

### 7. Install Dependencies

```bash
cd ~/.claude/slack-bridge
npm install
```

### 8. Run Claude Code in tmux

```bash
# Start a new tmux session named 'claude'
tmux new -s claude

# Inside tmux, run Claude Code
claude

# Detach with: Ctrl+B, then D
```

### 9. Start the Bridge

```bash
# In another terminal
cd ~/.claude/slack-bridge
npm start

# Or run in background
nohup npm start > bridge.log 2>&1 &
```

## Usage

- **DM the bot**: Send a direct message to your Claude Code bot
- **@mention**: In any channel the bot is in, type `@Claude Code your message`

The bridge will:
1. Receive your message
2. React with 👀 to confirm receipt
3. Send the text to Claude Code via tmux
4. Claude processes and responds (visible in tmux)
5. Claude's notification hook sends status updates to Slack

## Notifications

Claude Code sends notifications when:
- `:hourglass:` Waiting for your input (idle > 60 seconds)
- `:lock:` Permission needed to proceed
- `:white_check_mark:` Finished responding

## Environment Variables

- `CLAUDE_TMUX_SESSION` - tmux session name (default: `claude`)
- `CLAUDE_TMUX_WINDOW` - tmux window number (default: `0`)

## Troubleshooting

**"tmux session not found"**
- Start Claude Code in tmux first: `tmux new -s claude`

**Messages not being sent**
- Check the bridge logs
- Verify your user ID is in `allowedUsers`
- Make sure the bot has the right permissions

**Bot not responding to DMs**
- Go to Slack App settings → **App Home** → Enable "Messages Tab"
- Check "Allow users to send Slash commands and messages from the messages tab"

**Notifications not arriving**
- Check `notifyChannel` in config.json is correct
- For DMs, use your user ID (e.g., `"U12345678"`) not your username
- Verify bot has `chat:write` scope
