#!/bin/bash
# Claude Code Slack Notification Hook (Multi-Session)
# Uses Slack Bot Token (xoxb-) to send messages via Web API

CONFIG_FILE="$HOME/.claude/slack-bridge/config.json"
SESSIONS_FILE="/tmp/claude-slack-sessions.json"
SESSIONS_LOCK="/tmp/claude-slack-sessions.lock"
TMUX_SESSION="${CLAUDE_TMUX_SESSION:-claude}"
LAST_SENT_HASH_FILE="/tmp/claude-slack-last-sent-hash"
LAST_SENT_TIME_FILE="/tmp/claude-slack-last-sent-time"
COOLDOWN_SECONDS=3

# Load bot token from config
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

BOT_TOKEN=$(jq -r '.botToken // empty' "$CONFIG_FILE")
DEFAULT_CHANNEL=$(jq -r '.notifyChannel // empty' "$CONFIG_FILE")

if [[ -z "$BOT_TOKEN" ]]; then
  echo "Error: botToken not found in config" >&2
  exit 1
fi

# Read the hook input from stdin
INPUT=$(cat)

# Debug logging (uncomment for troubleshooting)
# DEBUG_FILE="/tmp/claude-slack-debug.log"
# echo "=== $(date) ===" >> "$DEBUG_FILE"
# echo "INPUT: $INPUT" >> "$DEBUG_FILE"

# Check if we're running inside the correct tmux session
is_in_tmux_session() {
  # Not in tmux at all
  [[ -z "$TMUX" ]] && return 1

  # Get current tmux session name
  local current_session
  current_session=$(tmux display-message -p '#{session_name}' 2>/dev/null)

  # Check if it matches our target session
  [[ "$current_session" == "$TMUX_SESSION" ]]
}

# Skip if not running inside the correct tmux session
if ! is_in_tmux_session; then
  exit 0
fi

# Parse session information from hook input
EVENT_TYPE=$(echo "$INPUT" | jq -r '.hook_event_name // "unknown"')
SESSION_ID_FULL=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
SESSION_ID="${SESSION_ID_FULL:0:8}"  # First 8 chars for window name
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' | xargs basename 2>/dev/null || echo "unknown")

# Get window name for THIS pane (not the active window)
# TMUX_PANE env var is set by tmux for each pane
if [[ -n "$TMUX_PANE" ]]; then
  CURRENT_WINDOW=$(tmux display-message -t "$TMUX_PANE" -p '#{window_name}' 2>/dev/null)
else
  CURRENT_WINDOW=$(tmux display-message -p '#{window_name}' 2>/dev/null)
fi

# Lookup thread_ts and channel by session_id (window name) in sessions.json
# Check both SESSION_ID and CURRENT_WINDOW because:
# - Before first response: window is "new-X", SESSION_ID is the new session_id
# - After rename: window is session_id, both should match
THREAD_TS=""
CHANNEL=""
if [[ -f "$SESSIONS_FILE" ]]; then
  SESSION_DATA=$(jq -r "to_entries[] | select(.value.window == \"$SESSION_ID\" or .value.window == \"$CURRENT_WINDOW\") | \"\(.key)|\(.value.channel)\"" "$SESSIONS_FILE" | head -1)
  THREAD_TS=$(echo "$SESSION_DATA" | cut -d'|' -f1)
  CHANNEL=$(echo "$SESSION_DATA" | cut -d'|' -f2)
fi

# Fallback to environment variables (for tool isolation) or default channel
if [[ -z "$THREAD_TS" ]]; then
  THREAD_TS="${CLAUDE_THREAD_TS:-}"
fi
if [[ -z "$CHANNEL" ]]; then
  CHANNEL="${CLAUDE_SLACK_CHANNEL:-$DEFAULT_CHANNEL}"
fi

if [[ -z "$CHANNEL" ]]; then
  echo "Error: No channel found for session" >&2
  exit 1
fi

# Capture permission prompt from bottom of terminal
capture_permission_prompt() {
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    return
  fi

  # Capture last 50 lines of terminal
  local content
  content=$(tmux capture-pane -t "$TMUX_SESSION:$CURRENT_WINDOW" -p -S -50 2>/dev/null)

  # Extract: tool call context + question + options
  echo "$content" | awk '
    # Capture tool call lines (context)
    /● [A-Za-z]+\(/ {
      context = $0
      in_context = 1
      next
    }
    # Continuation of context - file description and content preview only
    in_context && /^[[:space:]]+[0-9]+\./ {
      in_context = 0
    }
    in_context && /\?/ {
      in_context = 0
    }
    in_context {
      context = context "\n" $0
      next
    }
    # Found a question line
    /\?/ && !/http/ {
      prompt = $0
      options = ""
      capturing = 1
      next
    }
    # Capture all option lines and hint after question
    capturing && (/[❯►].*[0-9]+\./ || /^[[:space:]]+[0-9]+\./ || /Esc to cancel/) {
      options = options "\n" $0
      next
    }
    END {
      if (prompt != "" && options != "") {
        if (context != "") {
          print context
          print ""
        }
        print prompt
        print options
      }
    }
  '
}

# Capture response text between last marker and status line
capture_response() {
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    return
  fi

  # Wait for terminal output to stabilize
  local prev_content=""
  local content=""
  local stable_count=0

  for i in {1..10}; do
    sleep 0.3
    content=$(tmux capture-pane -t "$TMUX_SESSION:$CURRENT_WINDOW" -p -S -500 2>/dev/null)

    if [[ "$content" == "$prev_content" ]]; then
      stable_count=$((stable_count + 1))
      if [[ $stable_count -ge 2 ]]; then
        break
      fi
    else
      stable_count=0
      prev_content="$content"
    fi
  done

  # Extract text between last response marker and end marker
  echo "$content" | awk '
    /●/ {
      capture = $0
      capturing = 1
      next
    }
    /[✻✽✢✶·]/ || /^[─━]{20,}$/ || /^❯/ || /^\* .+…/ {
      if (capturing) {
        last_complete = capture
        capturing = 0
      }
      next
    }
    capturing {
      capture = capture "\n" $0
    }
    END {
      if (last_complete != "") {
        print last_complete
      } else if (capturing && capture != "") {
        print capture
      }
    }
  ' | sed '/^[[:space:]]*$/d'
}

# Escape text for JSON
json_escape() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//$'\n'/\\n}"
  text="${text//$'\r'/}"
  text="${text//$'\t'/  }"
  echo "$text"
}

# Build message based on event type
INCLUDE_RESPONSE=false
INCLUDE_PROMPT=false

case "$EVENT_TYPE" in
  "Notification")
    NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.notification_type // .matcher // "unknown"')
    case "$NOTIFICATION_TYPE" in
      "idle_prompt")
        # Update session status to idle (with file locking)
        if [[ -n "$THREAD_TS" && -f "$SESSIONS_FILE" ]]; then
          IDLE_TIME=$(date -Iseconds)
          flock "$SESSIONS_LOCK" -c "
            TMP_FILE=\$(mktemp)
            jq --arg ts \"$THREAD_TS\" --arg idle \"$IDLE_TIME\" \
              '.[\$ts].status = \"idle\" | .[\$ts].idle_since = \$idle' \
              \"$SESSIONS_FILE\" > \"\$TMP_FILE\" && mv \"\$TMP_FILE\" \"$SESSIONS_FILE\"
          "
        fi
        # Don't send notification to Slack - Stop event already notifies
        exit 0
        ;;
      "permission_prompt")
        MESSAGE=":lock: Claude Code needs permission to proceed"
        INCLUDE_PROMPT=true
        ;;
      *)
        # Skip unknown notification types
        exit 0
        ;;
    esac
    ;;
  "Stop")
    # On Stop event, rename window if it still has temporary name
    if [[ "$CURRENT_WINDOW" == new-* && "$SESSION_ID" != "unknown" ]]; then
      # Rename tmux window to session_id
      tmux rename-window -t "$TMUX_SESSION:$CURRENT_WINDOW" "$SESSION_ID" 2>/dev/null

      # Update CURRENT_WINDOW to the new name for capture functions
      CURRENT_WINDOW="$SESSION_ID"

      # Update sessions.json with new window name and full session ID (with file locking)
      if [[ -n "$THREAD_TS" && -f "$SESSIONS_FILE" ]]; then
        flock "$SESSIONS_LOCK" -c "
          TMP_FILE=\$(mktemp)
          jq --arg ts \"$THREAD_TS\" --arg sid \"$SESSION_ID\" --arg sidfull \"$SESSION_ID_FULL\" \
            '.[\$ts].window = \$sid | .[\$ts].sessionId = \$sidfull | .[\$ts].status = \"active\"' \
            \"$SESSIONS_FILE\" > \"\$TMP_FILE\" && mv \"\$TMP_FILE\" \"$SESSIONS_FILE\"
        "
      fi
    fi

    # Remove eyes reaction from the message that triggered this response
    if [[ -n "$THREAD_TS" && -f "$SESSIONS_FILE" ]]; then
      LAST_MSG_TS=$(jq -r ".\"$THREAD_TS\".lastMessageTs // empty" "$SESSIONS_FILE")
      if [[ -n "$LAST_MSG_TS" ]]; then
        # Remove eyes reaction via Slack API
        curl -s -X POST "https://slack.com/api/reactions.remove" \
          -H "Authorization: Bearer $BOT_TOKEN" \
          -H "Content-type: application/json" \
          -d "{\"channel\": \"$CHANNEL\", \"name\": \"eyes\", \"timestamp\": \"$LAST_MSG_TS\"}" > /dev/null

        # Clear lastMessageTs
        flock "$SESSIONS_LOCK" -c "
          TMP_FILE=\$(mktemp)
          jq --arg ts \"$THREAD_TS\" 'del(.[\$ts].lastMessageTs)' \
            \"$SESSIONS_FILE\" > \"\$TMP_FILE\" && mv \"\$TMP_FILE\" \"$SESSIONS_FILE\"
        "
      fi
    fi

    MESSAGE=":white_check_mark: Claude Code finished responding"
    INCLUDE_RESPONSE=true
    ;;
  "SubagentStop")
    MESSAGE=":robot_face: Claude Code subagent task completed"
    INCLUDE_RESPONSE=false
    ;;
  *)
    MESSAGE=":speech_balloon: Claude Code event: $EVENT_TYPE"
    INCLUDE_RESPONSE=false
    ;;
esac

# Build the full message
FULL_MESSAGE="$MESSAGE\n:file_folder: Project: \`$CWD\` | Session: \`$SESSION_ID\`"

# Add response summary if applicable
if [[ "$INCLUDE_RESPONSE" == "true" ]]; then
  RESPONSE=$(capture_response)
  if [[ -n "$RESPONSE" ]]; then
    ESCAPED_RESPONSE=$(json_escape "$RESPONSE")
    FULL_MESSAGE="$FULL_MESSAGE\n\n\`\`\`\n$ESCAPED_RESPONSE\n\`\`\`"
  fi
fi

# Add permission prompt if applicable
if [[ "$INCLUDE_PROMPT" == "true" ]]; then
  PROMPT=$(capture_permission_prompt)
  if [[ -n "$PROMPT" ]]; then
    ESCAPED_PROMPT=$(json_escape "$PROMPT")
    FULL_MESSAGE="$FULL_MESSAGE\n\n\`\`\`\n$ESCAPED_PROMPT\n\`\`\`"
  fi
fi

# Compute hash of message to detect duplicates
CONTENT_HASH=$(echo "$FULL_MESSAGE" | md5sum | cut -d' ' -f1)

# Check if this is a duplicate of the last sent message
if [[ -f "$LAST_SENT_HASH_FILE" ]]; then
  LAST_HASH=$(cat "$LAST_SENT_HASH_FILE" 2>/dev/null)
  if [[ "$CONTENT_HASH" == "$LAST_HASH" ]]; then
    exit 0
  fi
fi

# Check cooldown
if [[ -f "$LAST_SENT_TIME_FILE" ]]; then
  LAST_TIME=$(cat "$LAST_SENT_TIME_FILE" 2>/dev/null)
  NOW=$(date +%s)
  ELAPSED=$((NOW - LAST_TIME))
  if [[ $ELAPSED -lt $COOLDOWN_SECONDS ]]; then
    exit 0
  fi
fi

# Function to send a single message
send_message() {
  local text="$1"
  local payload="{\"channel\": \"$CHANNEL\", \"text\": \"$text\", \"unfurl_links\": false"
  if [[ -n "$THREAD_TS" ]]; then
    payload="$payload, \"thread_ts\": \"$THREAD_TS\""
  fi
  payload="$payload}"

  curl -s -X POST "https://slack.com/api/chat.postMessage" \
    -H "Authorization: Bearer $BOT_TOKEN" \
    -H "Content-type: application/json" \
    -d "$payload" > /dev/null
}

# Split and send message if too long (Slack limit is ~4000 chars)
MAX_LENGTH=3500
MSG_LENGTH=${#FULL_MESSAGE}

if [[ $MSG_LENGTH -le $MAX_LENGTH ]]; then
  # Message fits in one chunk
  send_message "$FULL_MESSAGE"
else
  # Split into multiple messages
  PART=1
  REMAINING="$FULL_MESSAGE"

  while [[ ${#REMAINING} -gt 0 ]]; do
    if [[ ${#REMAINING} -le $MAX_LENGTH ]]; then
      # Last chunk
      CHUNK="$REMAINING"
      REMAINING=""
    else
      # Find a good break point (newline) near the limit
      CHUNK="${REMAINING:0:$MAX_LENGTH}"
      # Try to break at last newline
      LAST_NEWLINE=$(echo "$CHUNK" | grep -bo '\\n' | tail -1 | cut -d: -f1)
      if [[ -n "$LAST_NEWLINE" && $LAST_NEWLINE -gt 1000 ]]; then
        CHUNK="${REMAINING:0:$LAST_NEWLINE}"
        REMAINING="${REMAINING:$LAST_NEWLINE}"
      else
        REMAINING="${REMAINING:$MAX_LENGTH}"
      fi
    fi

    # Add part indicator if splitting
    if [[ $PART -eq 1 && -n "$REMAINING" ]]; then
      CHUNK="$CHUNK\\n_(continued...)_"
    elif [[ $PART -gt 1 ]]; then
      CHUNK="_(part $PART)_\\n$CHUNK"
    fi

    send_message "$CHUNK"
    PART=$((PART + 1))

    # Small delay between messages to maintain order
    [[ -n "$REMAINING" ]] && sleep 0.2
  done
fi

# Update session last_activity timestamp (message forwarded to Slack)
if [[ -n "$THREAD_TS" && -f "$SESSIONS_FILE" ]]; then
  ACTIVITY_TIME=$(date -Iseconds)
  flock "$SESSIONS_LOCK" -c "
    TMP_FILE=\$(mktemp)
    jq --arg ts \"$THREAD_TS\" --arg activity \"$ACTIVITY_TIME\" \
      '.[\$ts].last_activity = \$activity' \
      \"$SESSIONS_FILE\" > \"\$TMP_FILE\" && mv \"\$TMP_FILE\" \"$SESSIONS_FILE\"
  "
fi

# Store hash and timestamp to prevent duplicates
echo "$CONTENT_HASH" > "$LAST_SENT_HASH_FILE"
date +%s > "$LAST_SENT_TIME_FILE"

exit 0
