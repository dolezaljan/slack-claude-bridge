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
SESSIONS_LOCK="/tmp/claude-slack-sessions.lock"

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

# Build message with directory prefix
DIR_DISPLAY="${WORKING_DIR/#$HOME/~}"
if [[ -z "$MESSAGE" ]]; then
  FULL_MESSAGE="[$DIR_DISPLAY] Starting session"
else
  FULL_MESSAGE="[$DIR_DISPLAY] $MESSAGE"
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

# Check tmux session exists
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "Error: tmux session '$TMUX_SESSION' not found" >&2
  echo "Start it with: tmux new -s $TMUX_SESSION" >&2
  exit 1
fi

# Generate window name (get next index from sessions file)
WINDOW_INDEX=$(jq -r '[to_entries[].value.window | select(startswith("new-")) | ltrimstr("new-") | tonumber] | max // 0' "$SESSIONS_FILE" 2>/dev/null || echo "0")
WINDOW_INDEX=$((WINDOW_INDEX + 1))
WINDOW_NAME="new-${WINDOW_INDEX}"

echo "  Creating tmux window: $WINDOW_NAME"

# Create new tmux window
tmux new-window -d -t "${TMUX_SESSION}:" -n "$WINDOW_NAME"
sleep 0.3

# Change to working directory
tmux send-keys -t "${TMUX_SESSION}:${WINDOW_NAME}" "cd \"$WORKING_DIR\"" Enter
sleep 0.1

# Start Claude with environment variables for thread context
tmux send-keys -t "${TMUX_SESSION}:${WINDOW_NAME}" "CLAUDE_THREAD_TS=$THREAD_TS CLAUDE_SLACK_CHANNEL=$CHANNEL claude" Enter

# If message provided, wait for Claude to be ready and send it
if [[ -n "$MESSAGE" ]]; then
  echo "  Waiting for Claude to be ready..."
  READY=false
  for i in {1..50}; do  # 15 seconds max (50 * 0.3)
    CONTENT=$(tmux capture-pane -t "${TMUX_SESSION}:${WINDOW_NAME}" -p 2>/dev/null)
    # Check for ready indicators
    if echo "$CONTENT" | grep -qE '(Welcome|❯|What would you like)'; then
      READY=true
      break
    fi
    sleep 0.3
  done

  if [[ "$READY" == "true" ]]; then
    sleep 0.2  # Extra settle time
    echo "  Sending message to Claude..."
    # Escape the message for tmux send-keys
    tmux send-keys -t "${TMUX_SESSION}:${WINDOW_NAME}" -l "$MESSAGE"
    tmux send-keys -t "${TMUX_SESSION}:${WINDOW_NAME}" Enter
  else
    echo "  Warning: Claude didn't become ready in time, message not sent" >&2
  fi
fi

# Register session in sessions.json
echo "  Registering session..."
CREATED_AT=$(date -Iseconds)
flock "$SESSIONS_LOCK" -c "
  if [[ ! -f '$SESSIONS_FILE' ]]; then
    echo '{}' > '$SESSIONS_FILE'
  fi
  TMP_FILE=\$(mktemp)
  jq --arg ts '$THREAD_TS' \
     --arg ch '$CHANNEL' \
     --arg win '$WINDOW_NAME' \
     --arg dir '$WORKING_DIR' \
     --arg created '$CREATED_AT' \
     '.[\$ts] = {channel: \$ch, window: \$win, workingDir: \$dir, status: \"active\", created_at: \$created}' \
     '$SESSIONS_FILE' > \"\$TMP_FILE\" && mv \"\$TMP_FILE\" '$SESSIONS_FILE'
"

echo "  Window: $WINDOW_NAME"
echo ""

# Check if we're already in the tmux session
if [[ -n "$TMUX" ]]; then
  # Already in tmux - just switch to the window
  CURRENT_SESSION=$(tmux display-message -p '#{session_name}')
  if [[ "$CURRENT_SESSION" == "$TMUX_SESSION" ]]; then
    echo "Switching to window $WINDOW_NAME..."
    tmux select-window -t "$TMUX_SESSION:$WINDOW_NAME"
  else
    echo "Switching to session $TMUX_SESSION:$WINDOW_NAME..."
    tmux switch-client -t "$TMUX_SESSION:$WINDOW_NAME"
  fi
else
  # Not in tmux - attach to the session and window
  echo "Attaching to tmux session..."
  tmux attach -t "$TMUX_SESSION:$WINDOW_NAME"
fi
