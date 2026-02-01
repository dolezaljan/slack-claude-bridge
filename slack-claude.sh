#!/bin/bash
# Start a Claude session that's linked to a Slack thread
# Usage: slack-claude [working_dir] [initial_message]
#
# Examples:
#   slack-claude                          # Current dir, default message
#   slack-claude ~/projects/myapp         # Specific dir
#   slack-claude . "Fix the login bug"    # Current dir with message

CONFIG_FILE="$HOME/.claude/slack-bridge/config.json"
SESSIONS_FILE="/tmp/claude-slack-sessions.json"

# Load config
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

BOT_TOKEN=$(jq -r '.botToken // empty' "$CONFIG_FILE")
CHANNEL=$(jq -r '.notifyChannel // empty' "$CONFIG_FILE")
TMUX_SESSION=$(jq -r '.multiSession.tmuxSession // "claude"' "$CONFIG_FILE")

if [[ -z "$BOT_TOKEN" || -z "$CHANNEL" ]]; then
  echo "Error: botToken or notifyChannel not found in config" >&2
  exit 1
fi

# Parse arguments
# If single arg and it's not a directory, treat it as message
if [[ $# -eq 1 && ! -d "$1" ]]; then
  WORKING_DIR="."
  MESSAGE="$1"
elif [[ $# -ge 1 ]]; then
  WORKING_DIR="$1"
  MESSAGE="${2:-}"
else
  WORKING_DIR="."
  MESSAGE=""
fi

# Resolve working directory to absolute path
if [[ ! -d "$WORKING_DIR" ]]; then
  echo "Error: Directory not found: $WORKING_DIR" >&2
  exit 1
fi
WORKING_DIR=$(cd "$WORKING_DIR" && pwd)

# Build message with directory prefix and marker for bridge to recognize
DIR_DISPLAY="${WORKING_DIR/#$HOME/~}"
if [[ -z "$MESSAGE" ]]; then
  FULL_MESSAGE="[$WORKING_DIR] Starting session [slack-claude]"
else
  FULL_MESSAGE="[$WORKING_DIR] $MESSAGE [slack-claude]"
fi

echo "Starting Claude session..."
echo "  Directory: $DIR_DISPLAY"
echo "  Posting to Slack..."

# Post message to Slack
RESPONSE=$(curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-type: application/json" \
  -d "{\"channel\": \"$CHANNEL\", \"text\": \"$FULL_MESSAGE\"}")

OK=$(echo "$RESPONSE" | jq -r '.ok')
if [[ "$OK" != "true" ]]; then
  ERROR=$(echo "$RESPONSE" | jq -r '.error // "unknown error"')
  echo "Error posting to Slack: $ERROR" >&2
  exit 1
fi

THREAD_TS=$(echo "$RESPONSE" | jq -r '.ts')
echo "  Thread: $THREAD_TS"

# Wait for bridge to create the session
echo "  Waiting for bridge to create session..."
WINDOW=""
for i in {1..60}; do
  if [[ -f "$SESSIONS_FILE" ]]; then
    WINDOW=$(jq -r ".\"$THREAD_TS\".window // empty" "$SESSIONS_FILE" 2>/dev/null)
    if [[ -n "$WINDOW" ]]; then
      break
    fi
  fi
  sleep 0.5
done

if [[ -z "$WINDOW" ]]; then
  echo "Error: Timeout waiting for bridge to create session" >&2
  echo "Is the bridge running? Check: ./start.sh" >&2
  exit 1
fi

echo "  Window: $WINDOW"
echo ""

# Check if we're already in the tmux session
if [[ -n "$TMUX" ]]; then
  # Already in tmux - just switch to the window
  CURRENT_SESSION=$(tmux display-message -p '#{session_name}')
  if [[ "$CURRENT_SESSION" == "$TMUX_SESSION" ]]; then
    echo "Switching to window $WINDOW..."
    tmux select-window -t "$TMUX_SESSION:$WINDOW"
  else
    echo "Switching to session $TMUX_SESSION:$WINDOW..."
    tmux switch-client -t "$TMUX_SESSION:$WINDOW"
  fi
else
  # Not in tmux - attach to the session and window
  echo "Attaching to tmux session..."
  tmux attach -t "$TMUX_SESSION:$WINDOW"
fi
