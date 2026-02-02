#!/bin/bash
# Claude Code Slack Bridge - Installation Script
#
# This script:
# 1. Installs npm dependencies
# 2. Creates config.json with your Slack credentials
# 3. Sets up symlinks for hooks and commands
# 4. Configures Claude Code hooks in settings.json
#
# Run from the slack-bridge directory:
#   ./install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
LOCAL_BIN="$HOME/.local/bin"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
CONFIG_FILE="$SCRIPT_DIR/config.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "============================================"
echo "  Claude Code Slack Bridge - Installer"
echo "============================================"
echo -e "${NC}"

# Check dependencies
echo -e "${BLUE}Checking dependencies...${NC}"

if ! command -v node &> /dev/null; then
  echo -e "${RED}Error: Node.js is required but not installed.${NC}"
  echo "Install it from https://nodejs.org/ or via your package manager."
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo -e "${RED}Error: npm is required but not installed.${NC}"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq is required but not installed.${NC}"
  echo "Install it via: sudo apt install jq / brew install jq / dnf install jq"
  exit 1
fi

if ! command -v tmux &> /dev/null; then
  echo -e "${RED}Error: tmux is required but not installed.${NC}"
  echo "Install it via: sudo apt install tmux / brew install tmux / dnf install tmux"
  exit 1
fi

if ! command -v claude &> /dev/null; then
  echo -e "${RED}Error: Claude Code CLI is required but not installed.${NC}"
  echo "Install it from https://claude.ai/code"
  exit 1
fi

echo -e "${GREEN}All dependencies found.${NC}"
echo ""

# Install npm packages
echo -e "${BLUE}Installing npm packages...${NC}"
cd "$SCRIPT_DIR"
npm install --silent
echo -e "${GREEN}npm packages installed.${NC}"
echo ""

# Helper function to create symlink with conflict handling
create_symlink() {
  local target="$1"
  local link="$2"
  local link_dir=$(dirname "$link")
  local link_name=$(basename "$link")

  # Create directory if needed
  if [[ ! -d "$link_dir" ]]; then
    mkdir -p "$link_dir"
    echo -e "  Created directory: $link_dir"
  fi

  # Check if link already exists
  if [[ -L "$link" ]]; then
    local current_target=$(readlink "$link")
    if [[ "$current_target" == "$target" ]]; then
      echo -e "  ${GREEN}✓${NC} $link_name (already correct)"
      return 0
    else
      echo -e "  ${YELLOW}!${NC} $link_name exists but points to: $current_target"
      echo -e "     Expected: $target"
      echo -n "     Replace it? [y/N]: "
      read -r response
      if [[ "$response" =~ ^[Yy]$ ]]; then
        rm "$link"
        ln -s "$target" "$link"
        echo -e "  ${GREEN}✓${NC} $link_name updated"
      else
        echo -e "  ${YELLOW}⚠${NC} $link_name skipped"
        return 1
      fi
    fi
  elif [[ -e "$link" ]]; then
    echo -e "  ${YELLOW}!${NC} $link_name exists as a regular file"
    echo -n "     Replace it with symlink? [y/N]: "
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
      rm "$link"
      ln -s "$target" "$link"
      echo -e "  ${GREEN}✓${NC} $link_name created"
    else
      echo -e "  ${YELLOW}⚠${NC} $link_name skipped"
      return 1
    fi
  else
    ln -s "$target" "$link"
    echo -e "  ${GREEN}✓${NC} $link_name created"
  fi
  return 0
}

# Create symlinks
echo -e "${BLUE}Setting up symlinks...${NC}"

create_symlink "$SCRIPT_DIR/slack-notify.sh" "$CLAUDE_DIR/slack-notify.sh"
create_symlink "$SCRIPT_DIR/slack-upload.sh" "$CLAUDE_DIR/slack-upload.sh"
create_symlink "$SCRIPT_DIR/slack-forward-prompt.sh" "$CLAUDE_DIR/slack-forward-prompt.sh"
create_symlink "$SCRIPT_DIR/slack-read-thread.sh" "$CLAUDE_DIR/slack-read-thread.sh"
create_symlink "$SCRIPT_DIR/slack-claude.sh" "$LOCAL_BIN/slack-claude"
create_symlink "$SCRIPT_DIR/slack-claude-start.sh" "$LOCAL_BIN/slack-claude-start"
create_symlink "$SCRIPT_DIR/slack-bridge.md" "$CLAUDE_DIR/rules/slack-bridge.md"

echo ""

# Configure config.json
echo -e "${BLUE}Configuring Slack credentials...${NC}"

if [[ -f "$CONFIG_FILE" ]]; then
  echo -e "${YELLOW}config.json already exists.${NC}"
  echo -n "Reconfigure credentials? [y/N]: "
  read -r response
  if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo "Keeping existing configuration."
    SKIP_CONFIG=true
  fi
fi

if [[ "$SKIP_CONFIG" != "true" ]]; then
  echo ""
  echo "You'll need these from your Slack App settings (https://api.slack.com/apps):"
  echo ""

  # Bot Token
  echo -e "${BLUE}1. Bot User OAuth Token${NC} (OAuth & Permissions → Bot User OAuth Token)"
  echo "   Starts with: xoxb-"
  echo -n "   Enter Bot Token: "
  read -r BOT_TOKEN

  if [[ ! "$BOT_TOKEN" =~ ^xoxb- ]]; then
    echo -e "${YELLOW}Warning: Token doesn't start with 'xoxb-'. Make sure it's correct.${NC}"
  fi

  echo ""

  # App Token
  echo -e "${BLUE}2. App-Level Token${NC} (Basic Information → App-Level Tokens)"
  echo "   Starts with: xapp-"
  echo "   Needs 'connections:write' scope"
  echo -n "   Enter App Token: "
  read -r APP_TOKEN

  if [[ ! "$APP_TOKEN" =~ ^xapp- ]]; then
    echo -e "${YELLOW}Warning: Token doesn't start with 'xapp-'. Make sure it's correct.${NC}"
  fi

  echo ""

  # User ID
  echo -e "${BLUE}3. Your Slack User ID${NC} (Click your profile → ⋮ → Copy member ID)"
  echo "   Starts with: U"
  echo -n "   Enter User ID: "
  read -r USER_ID

  echo ""

  # Notify Channel
  echo -e "${BLUE}4. Notification Channel${NC}"
  echo "   For DMs, use your User ID: $USER_ID"
  echo "   For a channel, use the Channel ID (right-click channel → Copy link → extract ID)"
  echo -n "   Enter Channel ID [$USER_ID]: "
  read -r NOTIFY_CHANNEL
  NOTIFY_CHANNEL="${NOTIFY_CHANNEL:-$USER_ID}"

  echo ""

  # tmux session name
  echo -e "${BLUE}5. tmux Session Name${NC} (optional)"
  echo -n "   Enter session name [claude]: "
  read -r TMUX_SESSION
  TMUX_SESSION="${TMUX_SESSION:-claude}"

  # Write config
  cat > "$CONFIG_FILE" << EOF
{
  "botToken": "$BOT_TOKEN",
  "appToken": "$APP_TOKEN",
  "allowedUsers": ["$USER_ID"],
  "notifyChannel": "$NOTIFY_CHANNEL",
  "multiSession": {
    "maxConcurrent": 5,
    "idleTimeoutMinutes": 60,
    "tmuxSession": "$TMUX_SESSION",
    "defaultWorkingDir": "~"
  }
}
EOF

  echo -e "${GREEN}config.json created.${NC}"
fi

echo ""

# Configure Claude Code hooks
echo -e "${BLUE}Configuring Claude Code hooks...${NC}"

# Check if settings.json exists
if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "{}" > "$SETTINGS_FILE"
  echo "Created new settings.json"
fi

# Check if hooks are already configured
EXISTING_HOOKS=$(jq -r '.hooks // empty' "$SETTINGS_FILE")

if [[ -n "$EXISTING_HOOKS" && "$EXISTING_HOOKS" != "null" ]]; then
  # Check if our hooks are already there
  HAS_STOP=$(jq -r '.hooks.Stop // empty' "$SETTINGS_FILE")
  HAS_NOTIFICATION=$(jq -r '.hooks.Notification // empty' "$SETTINGS_FILE")
  HAS_USERPROMPT=$(jq -r '.hooks.UserPromptSubmit // empty' "$SETTINGS_FILE")

  if [[ -n "$HAS_STOP" || -n "$HAS_NOTIFICATION" || -n "$HAS_USERPROMPT" ]]; then
    echo -e "${YELLOW}Hooks already configured in settings.json.${NC}"
    echo -n "Overwrite hook configuration? [y/N]: "
    read -r response
    if [[ ! "$response" =~ ^[Yy]$ ]]; then
      echo "Keeping existing hooks."
      SKIP_HOOKS=true
    fi
  fi
fi

if [[ "$SKIP_HOOKS" != "true" ]]; then
  # Merge hooks into existing settings
  HOOKS_JSON=$(cat << 'EOF'
{
  "UserPromptSubmit": [
    {
      "matcher": "",
      "hooks": [
        {
          "type": "command",
          "command": "~/.claude/slack-forward-prompt.sh",
          "timeout": 5
        }
      ]
    }
  ],
  "Notification": [
    {
      "matcher": "idle_prompt",
      "hooks": [
        {
          "type": "command",
          "command": "~/.claude/slack-notify.sh",
          "timeout": 10
        }
      ]
    },
    {
      "matcher": "permission_prompt",
      "hooks": [
        {
          "type": "command",
          "command": "~/.claude/slack-notify.sh",
          "timeout": 10
        }
      ]
    }
  ],
  "Stop": [
    {
      "matcher": "",
      "hooks": [
        {
          "type": "command",
          "command": "~/.claude/slack-notify.sh",
          "timeout": 10
        }
      ]
    }
  ]
}
EOF
)

  # Update settings.json
  TMP_FILE=$(mktemp)
  jq --argjson hooks "$HOOKS_JSON" '.hooks = $hooks' "$SETTINGS_FILE" > "$TMP_FILE"
  mv "$TMP_FILE" "$SETTINGS_FILE"

  echo -e "${GREEN}Hooks configured in settings.json.${NC}"
fi

echo ""

# Summary
echo -e "${GREEN}"
echo "============================================"
echo "  Installation Complete!"
echo "============================================"
echo -e "${NC}"

echo "Files created/updated:"
echo "  - $CONFIG_FILE"
echo "  - $SETTINGS_FILE"
echo ""
echo "Symlinks:"
echo "  - ~/.claude/slack-notify.sh"
echo "  - ~/.claude/slack-upload.sh"
echo "  - ~/.claude/slack-forward-prompt.sh"
echo "  - ~/.claude/slack-read-thread.sh"
echo "  - ~/.local/bin/slack-claude"
echo "  - ~/.local/bin/slack-claude-start"
echo "  - ~/.claude/rules/slack-bridge.md (global Claude Code rules)"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo ""
echo "1. Start the bridge (creates tmux session if needed):"
echo "   slack-claude-start"
echo ""
echo "2. Send a DM to your bot in Slack to start a session!"
echo ""
echo "3. Or start from terminal:"
echo "   slack-claude ~/myproject \"Help me with this\""
echo ""
echo -e "${BLUE}Documentation:${NC} $SCRIPT_DIR/README.md"
echo ""
