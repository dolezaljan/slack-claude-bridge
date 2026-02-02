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

### 1. Clone the Repository

```bash
git clone https://github.com/dolezaljan/slack-claude-bridge.git ~/.claude/slack-bridge
cd ~/.claude/slack-bridge
```

### 2. Create Slack App

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it "Claude Code" and select your workspace

**Configure Bot Token Scopes** (OAuth & Permissions → Bot Token Scopes):
- `chat:write` - Send messages
- `channels:history` - Read channel messages (for @mentions)
- `im:history` - Read DMs
- `im:read` - Access DM info
- `reactions:write` - Add reactions
- `reactions:read` - Read reactions
- `app_mentions:read` - Receive @mentions
- `files:read` - Download file attachments
- `files:write` - Upload files to Slack

**Enable Socket Mode** (Socket Mode → Enable):
- Create an **App-Level Token** with `connections:write` scope
- Copy the token (starts with `xapp-`)

**Subscribe to Events** (Event Subscriptions → Enable → Subscribe to bot events):
- `message.im` - Direct messages
- `app_mention` - @mentions in channels

**Install App** (Install App → Install to Workspace):
- Copy the **Bot User OAuth Token** (starts with `xoxb-`)

**Get Your User ID**:
- In Slack, click your profile → **⋮** → **Copy member ID**

### 3. Run Install Script

```bash
./install.sh
```

The script will prompt for your tokens and:
- Install npm dependencies
- Create `config.json` with your credentials
- Create symlinks for hooks and commands
- Configure Claude Code hooks in `~/.claude/settings.json`

### 4. Start the Bridge

```bash
slack-claude-start
```

This creates tmux session `claude` with the bridge in window 0. Use `slack-claude-start --restart` to restart.

### Configuration Options

The install script creates `config.json`. Optional settings (defaults shown):

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

## Usage

### Starting a Session

**From Slack:**
- **DM the bot**: Send a direct message to start a new session
- **@mention**: In any channel, `@Claude Code your message`
- **Custom directory**: Prefix with `[/path/to/dir]` to set working directory

**From local machine:**
```bash
slack-claude [options] [working_dir] [initial_message]
```

Options:
- `--continue` - Resume the most recent session in the directory
- `--resume [id]` - Resume a session (interactive picker if no ID)
- `--list` - List available sessions with IDs

Examples:
```bash
slack-claude                              # Current dir, new session
slack-claude ~/projects/myapp             # Specific directory
slack-claude . "Fix the login bug"        # Current dir with message
slack-claude "Fix the login bug"          # Current dir with message (shorthand)
slack-claude --continue ~/myapp           # Resume last session in ~/myapp
slack-claude --resume .                   # Interactive session picker (fzf)
slack-claude --resume 878eff58 .          # Resume by ID prefix
slack-claude --list ~/myapp               # List sessions with IDs
```

This creates a Slack thread and opens the tmux window locally. You can then continue the conversation from either Slack (mobile) or the local terminal.

**Auto-start**: `slack-claude` automatically creates the tmux session and starts the bridge if they're not running. No need to run `start.sh` first.

**Session migration**: Using `--resume` with a session that wasn't previously connected to Slack will "migrate" it - a new thread is created and all new notifications will go there.

**Listing sessions**: Use `--list` to see available sessions with their IDs:
```
Sessions for ~/.claude/slack-bridge:

ID          Summary                                        Msgs    Modified
----------  ---------------------------------------------  ------  ----------
878eff58    Fix navigation and add PreCompact...              13       18m ago
9ed7e016    User Greeting and Assistance Offer                 2        1d ago
```

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
- Run `slack-claude-start` to create the tmux session

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
├── bridge.js               # Main bridge server
├── slack-notify.sh         # Hook: send notifications to Slack
├── slack-forward-prompt.sh # Hook: forward user prompts to Slack
├── slack-read-thread.sh    # Tool: read Slack thread history
├── slack-upload.sh         # Tool: upload files to Slack
├── slack-claude.sh         # Start Claude session from terminal
├── slack-claude-start.sh   # Start bridge infrastructure
├── slack-bridge.md         # Global Claude Code rules
├── install.sh              # Installation script
├── config.json             # Your configuration (gitignored)
├── config.example.json     # Template configuration
├── package.json            # Dependencies
└── README.md               # This file

Symlinks (created by install.sh):
~/.claude/slack-notify.sh         → slack-bridge/slack-notify.sh
~/.claude/slack-forward-prompt.sh → slack-bridge/slack-forward-prompt.sh
~/.claude/slack-read-thread.sh    → slack-bridge/slack-read-thread.sh
~/.claude/slack-upload.sh         → slack-bridge/slack-upload.sh
~/.claude/rules/slack-bridge.md   → slack-bridge/slack-bridge.md
~/.local/bin/slack-claude         → slack-bridge/slack-claude.sh
~/.local/bin/slack-claude-start   → slack-bridge/slack-claude-start.sh
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

---

## Appendix: Manual Setup

If you prefer not to use `install.sh`, here's the manual process:

### Install Dependencies

```bash
cd ~/.claude/slack-bridge
npm install
```

### Create config.json

```bash
cp config.example.json config.json
```

Edit with your tokens:
```json
{
  "botToken": "xoxb-your-bot-token",
  "appToken": "xapp-your-app-level-token",
  "allowedUsers": ["U12345678"],
  "notifyChannel": "U12345678"
}
```

### Create Symlinks

```bash
# Hook scripts (called by Claude Code)
ln -s ~/.claude/slack-bridge/slack-notify.sh ~/.claude/slack-notify.sh
ln -s ~/.claude/slack-bridge/slack-forward-prompt.sh ~/.claude/slack-forward-prompt.sh

# Tool scripts (called by Claude)
ln -s ~/.claude/slack-bridge/slack-read-thread.sh ~/.claude/slack-read-thread.sh
ln -s ~/.claude/slack-bridge/slack-upload.sh ~/.claude/slack-upload.sh

# Commands (in PATH)
ln -s ~/.claude/slack-bridge/slack-claude.sh ~/.local/bin/slack-claude
ln -s ~/.claude/slack-bridge/slack-claude-start.sh ~/.local/bin/slack-claude-start

# Global Claude Code rules
mkdir -p ~/.claude/rules
ln -s ~/.claude/slack-bridge/slack-bridge.md ~/.claude/rules/slack-bridge.md
```

### Configure Claude Code Hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "~/.claude/slack-forward-prompt.sh", "timeout": 5 }]
      }
    ],
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
