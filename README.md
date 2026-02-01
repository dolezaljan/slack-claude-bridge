# Claude Code Slack Bridge

> *For those who can't stop shipping, even from the throne.* 🚽👑
>
> Because sometimes inspiration strikes in the bathroom, and you're not about to grab your laptop. Now you can `fix that one bug` from your phone while... taking a break.

---

**Requires [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** - Anthropic's official AI coding assistant for the terminal.

Bidirectional bridge between Slack and Claude Code CLI. Send messages to Claude via Slack DM or @mentions, receive responses in threads. Control your AI coding assistant from anywhere - meetings, commutes, or *strategic thinking sessions*.

Supports multiple concurrent sessions, file/image attachments, and automatic session management.

## Architecture

```
You (Slack) → Socket Mode → bridge.js → tmux send-keys → Claude Code
Claude Code → slack-notify.sh → Bot API → Slack Thread → You
```

Each Slack thread gets its own Claude Code session in a separate tmux window.

## Features

- **Multi-session**: Each thread runs an independent Claude session
- **File attachments**: Send images, PDFs, and code files to Claude
- **Session resurrection**: Terminated sessions can be resumed
- **Idle timeout**: Sessions auto-terminate after inactivity
- **Bot commands**: Manage sessions directly from Slack

## Setup

### Clone the Repository

```bash
git clone https://github.com/dolezaljan/slack-claude-bridge.git ~/.claude/slack-bridge
cd ~/.claude/slack-bridge
```

### Quick Install

After creating your Slack app (steps 1-6 below), run the install script:

```bash
cd ~/.claude/slack-bridge
./install.sh
```

The script will:
- Install npm dependencies
- Prompt for your Slack credentials
- Create symlinks for hooks and commands
- Configure Claude Code hooks

### Manual Setup

If you prefer manual setup, follow these steps:

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
- `reactions:read` - Read reactions
- `app_mentions:read` - Receive @mentions
- `files:read` - Download file attachments
- `files:write` - Upload files to Slack

### 3. Enable Socket Mode

1. Go to **Socket Mode** → Enable
2. Create an **App-Level Token** with `connections:write` scope
3. Copy the token (starts with `xapp-`)

### 4. Subscribe to Events

Go to **Event Subscriptions** → Enable Events → **Subscribe to bot events**, add:
- `message.im` - Direct messages
- `app_mention` - @mentions in channels

### 5. Install App to Workspace

1. Go to **Install App** → Install to Workspace
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### 6. Get Your User ID

In Slack, click your profile → **⋮** → **Copy member ID**

### 7. Configure the Bridge

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
  "notifyChannel": "U12345678"
}
```

- `botToken` - Bot User OAuth Token from step 5
- `appToken` - App-Level Token from step 3
- `allowedUsers` - Your Slack user ID(s) from step 6
- `notifyChannel` - Fallback channel for notifications (use user ID for DMs)

Optional multi-session settings (defaults shown):
```json
{
  "multiSession": {
    "maxConcurrent": 5,
    "idleTimeoutMinutes": 60,
    "tmuxSession": "claude",
    "defaultWorkingDir": "~",
    "notifyOnTimeout": false,
    "tempFileRetentionDays": 14
  }
}
```

### 8. Install Dependencies

```bash
cd ~/.claude/slack-bridge
npm install
```

### 9. Setup Notification Hook

Create a symlink for the Claude Code hook:

```bash
ln -s ~/.claude/slack-bridge/slack-notify.sh ~/.claude/slack-notify.sh
```

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "idle_prompt",
        "hooks": [{ "type": "command", "command": "~/.claude/slack-notify.sh", "timeout": 10 }]
      },
      {
        "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "~/.claude/slack-notify.sh", "timeout": 10 }]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "~/.claude/slack-notify.sh", "timeout": 10 }]
      }
    ]
  }
}
```

### 10. Start the Bridge

```bash
cd ~/.claude/slack-bridge
./start.sh
```

This will:
- Create tmux session `claude` if needed
- Start the bridge in window 0 named `bridge`
- Show connection status and logs

## Usage

### Starting a Session

**From Slack:**
- **DM the bot**: Send a direct message to start a new session
- **@mention**: In any channel, `@Claude Code your message`
- **Custom directory**: Prefix with `[/path/to/dir]` to set working directory

**From local machine:**
```bash
slack-claude [working_dir] [initial_message]
```

Examples:
```bash
slack-claude                              # Current dir, no message
slack-claude ~/projects/myapp             # Specific directory
slack-claude . "Fix the login bug"        # Current dir with message
slack-claude "Fix the login bug"          # Current dir with message (shorthand)
```

This creates a Slack thread and opens the tmux window locally. You can then continue the conversation from either Slack (mobile) or the local terminal.

Each thread runs its own Claude instance.

### File Attachments

Attach files to your Slack message - they'll be downloaded and passed to Claude:

- **Images**: PNG, JPG, GIF, WEBP - Claude can see and analyze them
- **Documents**: PDF - Claude can read the content
- **Code/Text**: Most text-based files (.js, .py, .md, etc.)

### Uploading Files to Slack

Claude can upload files back to the Slack thread using the upload script:

```bash
~/.claude/slack-upload.sh <file> [message]
```

Examples:
```bash
~/.claude/slack-upload.sh ./screenshot.png "Here's the result"
~/.claude/slack-upload.sh /tmp/output.csv
```

The script automatically detects the current thread from environment variables or tmux window.

### Bot Commands

Send these in DM (outside of Claude session threads):

| Command | Description |
|---------|-------------|
| `!status` | Show bridge status |
| `!sessions` or `!s` | List active sessions |
| `!kill <window>` | Terminate a session |
| `!find <name>` or `!f` | Find project directories |
| `!help` | Show help |

**In-thread commands** (within a Claude session):

| Command | Description |
|---------|-------------|
| `!kill` | Terminate this session |
| `!status` | Show session info (window, directory, idle time) |

### Reactions

React to the thread's first message to control the session:

| Reaction | Action |
|----------|--------|
| 🛑 `:octagonal_sign:` | Kill/terminate session |
| ✅ `:white_check_mark:` | Approve permission prompt |
| ❌ `:x:` | Reject/cancel permission prompt |

### Slash Commands

If configured in Slack:
- `/claude-status` - Bridge status
- `/claude-sessions` - List sessions
- `/claude-kill <window>` - Kill session
- `/claude-find <query>` - Find directories
- `/claude-help` - Help

## Notifications

Claude sends status updates to the Slack thread:

| Emoji | Meaning |
|-------|---------|
| 👀 | Message received, processing |
| ✅ | Claude finished responding |
| 🔒 | Permission needed (with prompt details) |
| ⏱️ | Session timed out |
| ⚠️ | Session ended unexpectedly |

## Session Lifecycle

1. **New message** → Creates tmux window, starts Claude
2. **Active** → Messages forwarded bidirectionally
3. **Idle** → No activity, marked idle after response
4. **Timeout** → Auto-terminated after `idleTimeoutMinutes`
5. **Resurrection** → Send message to terminated thread to resume

## Troubleshooting

**"No server running on /tmp/tmux..."**
- Start tmux first: `tmux new -s claude` or use `./start.sh`

**Messages not being sent**
- Check `!status` - verify bridge is connected
- Verify your user ID is in `allowedUsers`

**Bot not responding to DMs**
- Go to Slack App → **App Home** → Enable "Messages Tab"
- Check "Allow users to send Slash commands and messages"

**Files not downloading**
- Verify bot has `files:read` scope
- Check bridge logs for download errors

**Session crashes immediately**
- Check tmux window for Claude errors
- Verify working directory exists

**Notifications not arriving**
- Verify `slack-notify.sh` symlink exists
- Check hooks are configured in `~/.claude/settings.json`
- Hook only runs inside tmux session `claude`

## Files

```
~/.claude/slack-bridge/
├── bridge.js           # Main bridge server
├── slack-notify.sh     # Claude notification hook
├── start.sh            # Convenience launcher
├── config.json         # Your configuration (gitignored)
├── config.example.json # Template configuration
├── package.json        # Dependencies
└── README.md           # This file

~/.claude/
├── slack-notify.sh     # Symlink → slack-bridge/slack-notify.sh
└── settings.json       # Claude hooks configuration
```

## Git/SSH in tmux Sessions

When running Claude inside tmux, SSH authentication may not work because the SSH agent socket from your login session isn't available. To fix this:

**Option 1: GNOME Keyring (Linux with GNOME)**

The GNOME keyring provides a persistent SSH agent:

```bash
SSH_AUTH_SOCK=/run/user/1000/gcr/ssh git push
```

Add to your shell config to make it automatic in tmux:
```bash
# ~/.bashrc or ~/.zshrc
if [[ -n "$TMUX" ]]; then
  export SSH_AUTH_SOCK=/run/user/$(id -u)/gcr/ssh
fi
```

**Option 2: SSH Agent Forwarding**

Start tmux with agent forwarding:
```bash
ssh-agent tmux new -s claude
```

**Option 3: Use HTTPS with gh CLI**

Configure git to use GitHub CLI for authentication:
```bash
gh auth setup-git
```

## Logs

- Bridge output: visible in tmux `claude:bridge` window
- Also written to `/tmp/slack-bridge.log`
- Session state: `/tmp/claude-slack-sessions.json`
- Downloaded files: `/tmp/claude-slack-files/<threadTs>/`
