#!/bin/bash
# Start a Claude session that's linked to a Slack thread
# Usage: slack-claude [options] [working_dir] [initial_message]
#
# Options:
#   --continue           Resume the most recent session in the directory
#   --resume [id]        Resume a session (interactive picker if no ID)
#   --list               List available sessions with IDs
#
# Examples:
#   slack-claude                          # Current dir, new session
#   slack-claude ~/projects/myapp         # Specific dir, new session
#   slack-claude . "Fix the login bug"    # Current dir with message
#   slack-claude --continue ~/myapp       # Resume last session in ~/myapp
#   slack-claude --resume .               # Interactive session picker
#   slack-claude --resume abc123 .        # Resume by ID (or prefix)
#   slack-claude --list ~/myapp           # List sessions for directory

CONFIG_FILE="$HOME/.claude/slack-bridge/config.json"
SESSIONS_FILE="/tmp/claude-slack-sessions.json"
SESSIONS_LOCK="/tmp/claude-slack-sessions.lock"

# Get Claude sessions index path for a directory
get_sessions_index() {
  local dir="$1"
  local encoded="${dir//\//-}"  # Replace / with -
  encoded="${encoded//./-}"     # Replace . with -
  echo "$HOME/.claude/projects/$encoded/sessions-index.json"
}

# Format relative time
relative_time() {
  local seconds="$1"
  if [[ $seconds -lt 60 ]]; then
    echo "${seconds}s ago"
  elif [[ $seconds -lt 3600 ]]; then
    echo "$((seconds / 60))m ago"
  elif [[ $seconds -lt 86400 ]]; then
    echo "$((seconds / 3600))h ago"
  else
    echo "$((seconds / 86400))d ago"
  fi
}

# List sessions for a directory
list_sessions() {
  local dir="$1"
  local index_file
  index_file=$(get_sessions_index "$dir")

  if [[ ! -f "$index_file" ]]; then
    echo "No sessions found for $dir" >&2
    return 1
  fi

  local now
  now=$(date +%s)

  echo "Sessions for ${dir/#$HOME/~}:"
  echo ""
  printf "%-10s  %-45s  %6s  %10s\n" "ID" "Summary" "Msgs" "Modified"
  printf "%-10s  %-45s  %6s  %10s\n" "----------" "---------------------------------------------" "------" "----------"

  jq -r --argjson now "$now" '.entries | sort_by(.modified) | reverse | .[] |
    [
      .sessionId[0:8],
      (.summary // .firstPrompt // "No summary")[0:45],
      .messageCount,
      (($now - (.modified | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) | tostring)
    ] | @tsv' "$index_file" 2>/dev/null | while IFS=$'\t' read -r id summary msgs modified_secs; do
      printf "%-10s  %-45s  %6s  %10s\n" "$id" "$summary" "$msgs" "$(relative_time "$modified_secs")"
    done
}

# Interactive session picker (uses fzf if available, falls back to select)
pick_session() {
  local dir="$1"
  local index_file
  index_file=$(get_sessions_index "$dir")

  if [[ ! -f "$index_file" ]]; then
    echo "No sessions found for $dir" >&2
    return 1
  fi

  local now
  now=$(date +%s)

  # Build session list
  local sessions=()
  local displays=()
  while IFS=$'\t' read -r full_id short_id summary msgs modified_secs; do
    sessions+=("$full_id")
    displays+=("$(printf "%-8s  %-45s  %3s msgs  %s" "$short_id" "$summary" "$msgs" "$(relative_time "$modified_secs")")")
  done < <(jq -r --argjson now "$now" '.entries | sort_by(.modified) | reverse | .[] |
    [
      .sessionId,
      .sessionId[0:8],
      (.summary // .firstPrompt // "No summary")[0:45],
      .messageCount,
      (($now - (.modified | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) | tostring)
    ] | @tsv' "$index_file" 2>/dev/null)

  if [[ ${#sessions[@]} -eq 0 ]]; then
    echo "No sessions found" >&2
    return 1
  fi

  local selection
  if command -v fzf &>/dev/null; then
    # Use fzf for nice interactive picker
    local idx
    idx=$(for i in "${!displays[@]}"; do
      printf "%s\t%s\n" "${sessions[$i]}" "${displays[$i]}"
    done | fzf --with-nth=2.. --delimiter='\t' --height=40% --reverse \
               --header="Select session (type to filter):" \
               --preview-window=hidden | cut -f1)
    selection="$idx"
  else
    # Fall back to simple numbered list
    echo "Select session to resume:" >&2
    PS3="Enter number: "
    select opt in "${displays[@]}"; do
      if [[ -n "$opt" ]]; then
        selection="${sessions[$((REPLY-1))]}"
        break
      fi
    done
  fi

  if [[ -z "$selection" ]]; then
    return 1
  fi

  echo "$selection"
}

# Find session by ID prefix
find_session_by_prefix() {
  local dir="$1"
  local prefix="$2"
  local index_file
  index_file=$(get_sessions_index "$dir")

  if [[ ! -f "$index_file" ]]; then
    return 1
  fi

  local matches
  matches=$(jq -r --arg prefix "$prefix" '.entries[] | select(.sessionId | startswith($prefix)) | .sessionId' "$index_file" 2>/dev/null)

  local count
  count=$(echo "$matches" | grep -c . || echo 0)

  if [[ $count -eq 0 ]]; then
    echo "No session found matching prefix: $prefix" >&2
    return 1
  elif [[ $count -gt 1 ]]; then
    echo "Multiple sessions match prefix '$prefix':" >&2
    echo "$matches" | while read -r id; do
      echo "  $id"
    done >&2
    return 1
  fi

  echo "$matches"
}

# Find Slack thread for a Claude session ID
find_thread_for_session() {
  local session_id="$1"

  if [[ ! -f "$SESSIONS_FILE" ]]; then
    return 1
  fi

  # Look for session by full ID or prefix match
  local result
  result=$(jq -r --arg sid "$session_id" '
    to_entries[]
    | select(.value.sessionId != null and (.value.sessionId == $sid or (.value.sessionId | startswith($sid))))
    | "\(.key)|\(.value.channel)"
  ' "$SESSIONS_FILE" 2>/dev/null | head -1)

  if [[ -n "$result" && "$result" != "|" ]]; then
    echo "$result"
    return 0
  fi

  return 1
}

# Ensure tmux session and bridge are running
ensure_bridge_running() {
  local tmux_session="$1"
  local bridge_dir="$HOME/.claude/slack-bridge"
  local log_file="/tmp/slack-bridge.log"

  # Create tmux session if it doesn't exist
  if ! tmux has-session -t "$tmux_session" 2>/dev/null; then
    echo "  Creating tmux session '$tmux_session'..."
    tmux new-session -d -s "$tmux_session" -n bridge -c "$bridge_dir"
    tmux send-keys -t "$tmux_session:bridge" "node bridge.js 2>&1 | tee $log_file" Enter
    sleep 2  # Wait for bridge to start
    return 0
  fi

  # Check if bridge process is running
  if pgrep -f "node bridge.js" > /dev/null; then
    return 0  # Bridge already running
  fi

  # Bridge not running - start it
  echo "  Starting bridge..."

  # Check if bridge window exists
  if tmux list-windows -t "$tmux_session" -F '#{window_name}' 2>/dev/null | grep -q '^bridge$'; then
    # Window exists, just start the process
    tmux send-keys -t "$tmux_session:bridge" "node bridge.js 2>&1 | tee $log_file" Enter
  else
    # Create bridge window
    tmux new-window -t "$tmux_session:" -n bridge -c "$bridge_dir"

    # Move to position 0 if possible
    local bridge_idx
    bridge_idx=$(tmux list-windows -t "$tmux_session" -F '#{window_index} #{window_name}' | grep ' bridge$' | cut -d' ' -f1)
    if [[ "$bridge_idx" != "0" ]]; then
      if tmux list-windows -t "$tmux_session" -F '#{window_index}' | grep -q '^0$'; then
        tmux swap-window -s "$tmux_session:$bridge_idx" -t "$tmux_session:0" 2>/dev/null || true
      else
        tmux move-window -s "$tmux_session:$bridge_idx" -t "$tmux_session:0" 2>/dev/null || true
      fi
    fi

    tmux send-keys -t "$tmux_session:bridge" "node bridge.js 2>&1 | tee $log_file" Enter
  fi

  # Wait for bridge to start
  echo "  Waiting for bridge to connect..."
  for i in {1..10}; do
    if pgrep -f "node bridge.js" > /dev/null; then
      sleep 1  # Extra time for Slack connection
      return 0
    fi
    sleep 0.5
  done

  echo "  Warning: Bridge may not have started properly" >&2
  return 1
}

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
RESUME_MODE=""
RESUME_ID=""
WORKING_DIR=""
MESSAGE=""
LIST_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --continue)
      RESUME_MODE="continue"
      shift
      ;;
    --resume)
      RESUME_MODE="resume"
      # Check if next arg is an ID (not a flag, not a directory)
      if [[ -n "$2" && "$2" != --* && ! -d "$2" ]]; then
        RESUME_ID="$2"
        shift 2
      else
        # No ID - will use picker later
        shift
      fi
      ;;
    --list|-l)
      LIST_MODE=true
      shift
      ;;
    -*)
      echo "Error: Unknown option: $1" >&2
      exit 1
      ;;
    *)
      # Positional arguments: [working_dir] [message]
      if [[ -z "$WORKING_DIR" ]]; then
        # First positional - could be dir or message
        if [[ -d "$1" ]]; then
          WORKING_DIR="$1"
        else
          # Not a directory - treat as message if no more args
          if [[ $# -eq 1 ]]; then
            WORKING_DIR="."
            MESSAGE="$1"
          else
            # Multiple args but first isn't a dir - error
            echo "Error: Directory not found: $1" >&2
            exit 1
          fi
        fi
      else
        # Second positional - must be message
        MESSAGE="$1"
      fi
      shift
      ;;
  esac
done

# Default working directory
WORKING_DIR="${WORKING_DIR:-.}"

# Resolve working directory to absolute path
if [[ ! -d "$WORKING_DIR" ]]; then
  echo "Error: Directory not found: $WORKING_DIR" >&2
  exit 1
fi
WORKING_DIR=$(cd "$WORKING_DIR" && pwd)

# Handle --list mode
if [[ "$LIST_MODE" == true ]]; then
  list_sessions "$WORKING_DIR"
  exit 0
fi

# Handle --resume without ID (interactive picker)
if [[ "$RESUME_MODE" == "resume" && -z "$RESUME_ID" ]]; then
  RESUME_ID=$(pick_session "$WORKING_DIR")
  if [[ -z "$RESUME_ID" ]]; then
    echo "No session selected" >&2
    exit 1
  fi
  echo "Selected session: ${RESUME_ID:0:8}..."
fi

# Handle --resume with ID prefix (resolve to full ID)
if [[ "$RESUME_MODE" == "resume" && -n "$RESUME_ID" && ${#RESUME_ID} -lt 36 ]]; then
  FULL_ID=$(find_session_by_prefix "$WORKING_DIR" "$RESUME_ID")
  if [[ -z "$FULL_ID" ]]; then
    exit 1
  fi
  RESUME_ID="$FULL_ID"
fi

# Build message with directory prefix
DIR_DISPLAY="${WORKING_DIR/#$HOME/~}"
if [[ -n "$RESUME_MODE" ]]; then
  if [[ "$RESUME_MODE" == "continue" ]]; then
    SESSION_DESC="Resuming last session"
  else
    SESSION_DESC="Resuming session ${RESUME_ID:0:8}"
  fi
  if [[ -z "$MESSAGE" ]]; then
    FULL_MESSAGE="[$DIR_DISPLAY] $SESSION_DESC"
  else
    FULL_MESSAGE="[$DIR_DISPLAY] $SESSION_DESC: $MESSAGE"
  fi
else
  if [[ -z "$MESSAGE" ]]; then
    FULL_MESSAGE="[$DIR_DISPLAY] Starting session"
  else
    FULL_MESSAGE="[$DIR_DISPLAY] $MESSAGE"
  fi
fi

if [[ -n "$RESUME_MODE" ]]; then
  if [[ "$RESUME_MODE" == "continue" ]]; then
    echo "Resuming Claude session (--continue)..."
  else
    echo "Resuming Claude session: ${RESUME_ID:0:8}..."
  fi
else
  echo "Starting Claude session..."
fi
echo "  Directory: $DIR_DISPLAY"

# Ensure tmux session and bridge are running
ensure_bridge_running "$TMUX_SESSION"

# When resuming, try to find the original Slack thread
THREAD_TS=""
if [[ "$RESUME_MODE" == "resume" && -n "$RESUME_ID" ]]; then
  echo "  Looking up original Slack thread..."
  THREAD_INFO=$(find_thread_for_session "$RESUME_ID")
  if [[ -n "$THREAD_INFO" ]]; then
    THREAD_TS=$(echo "$THREAD_INFO" | cut -d'|' -f1)
    FOUND_CHANNEL=$(echo "$THREAD_INFO" | cut -d'|' -f2)
    if [[ -n "$FOUND_CHANNEL" ]]; then
      CHANNEL="$FOUND_CHANNEL"
    fi
    echo "  Found original thread: $THREAD_TS"
  fi
fi

echo "  Posting to Slack..."

# Build Slack message payload
if [[ -n "$THREAD_TS" ]]; then
  # Reply to existing thread
  PAYLOAD="{\"channel\": \"$CHANNEL\", \"text\": \"$FULL_MESSAGE\", \"thread_ts\": \"$THREAD_TS\"}"
else
  # Start new thread
  PAYLOAD="{\"channel\": \"$CHANNEL\", \"text\": \"$FULL_MESSAGE\"}"
fi

# Post message to Slack
RESPONSE=$(curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-type: application/json" \
  -d "$PAYLOAD")

OK=$(echo "$RESPONSE" | jq -r '.ok')
if [[ "$OK" != "true" ]]; then
  ERROR=$(echo "$RESPONSE" | jq -r '.error // "unknown error"')
  echo "Error posting to Slack: $ERROR" >&2
  exit 1
fi

# For new threads, capture the thread_ts
if [[ -z "$THREAD_TS" ]]; then
  THREAD_TS=$(echo "$RESPONSE" | jq -r '.ts')
fi
echo "  Thread: $THREAD_TS"

# Generate window name
if [[ "$RESUME_MODE" == "resume" && -n "$RESUME_ID" ]]; then
  # Use short session ID for resumed sessions
  WINDOW_NAME="${RESUME_ID:0:8}"
else
  # Use incremental index for new sessions
  WINDOW_INDEX=$(jq -r '[to_entries[].value.window | select(startswith("new-")) | ltrimstr("new-") | tonumber] | max // 0' "$SESSIONS_FILE" 2>/dev/null || echo "0")
  WINDOW_INDEX=$((WINDOW_INDEX + 1))
  WINDOW_NAME="new-${WINDOW_INDEX}"
fi

echo "  Creating tmux window: $WINDOW_NAME"

# Create new tmux window
tmux new-window -d -t "${TMUX_SESSION}:" -n "$WINDOW_NAME"
sleep 0.3

# Change to working directory
tmux send-keys -t "${TMUX_SESSION}:${WINDOW_NAME}" "cd \"$WORKING_DIR\"" Enter
sleep 0.1

# Build Claude command with resume flags
CLAUDE_CMD="CLAUDE_THREAD_TS=$THREAD_TS CLAUDE_SLACK_CHANNEL=$CHANNEL claude"
if [[ "$RESUME_MODE" == "continue" ]]; then
  CLAUDE_CMD="$CLAUDE_CMD --continue"
elif [[ "$RESUME_MODE" == "resume" ]]; then
  CLAUDE_CMD="$CLAUDE_CMD --resume $RESUME_ID"
fi

# Start Claude with environment variables for thread context
tmux send-keys -t "${TMUX_SESSION}:${WINDOW_NAME}" "$CLAUDE_CMD" Enter

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

# Register/update session in sessions.json
echo "  Registering session..."
CREATED_AT=$(date -Iseconds)
if [[ "$RESUME_MODE" == "resume" && -n "$RESUME_ID" ]]; then
  # Update existing session entry (preserve sessionId)
  flock "$SESSIONS_LOCK" -c "
    if [[ ! -f '$SESSIONS_FILE' ]]; then
      echo '{}' > '$SESSIONS_FILE'
    fi
    TMP_FILE=\$(mktemp)
    jq --arg ts '$THREAD_TS' \
       --arg win '$WINDOW_NAME' \
       --arg activity '$CREATED_AT' \
       '.[\$ts].window = \$win | .[\$ts].status = \"active\" | .[\$ts].last_activity = \$activity | del(.[\$ts].idle_since)' \
       '$SESSIONS_FILE' > \"\$TMP_FILE\" && mv \"\$TMP_FILE\" '$SESSIONS_FILE'
  "
else
  # Create new session entry
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
fi

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
