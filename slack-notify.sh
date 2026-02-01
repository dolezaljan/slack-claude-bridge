#!/bin/bash
# Claude Code Slack Notification Hook (Multi-Session)
# Uses Slack Bot Token (xoxb-) to send messages via Web API

CONFIG_FILE="$HOME/.claude/slack-bridge/config.json"
SESSIONS_FILE="/tmp/claude-slack-sessions.json"
SESSIONS_LOCK="/tmp/claude-slack-sessions.lock"
TMUX_SESSION="${CLAUDE_TMUX_SESSION:-claude}"
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

# Check if we're running inside the correct tmux session
is_in_tmux_session() {
  [[ -z "$TMUX" ]] && return 1
  local current_session
  current_session=$(tmux display-message -p '#{session_name}' 2>/dev/null)
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

# Get window name for THIS pane
if [[ -n "$TMUX_PANE" ]]; then
  CURRENT_WINDOW=$(tmux display-message -t "$TMUX_PANE" -p '#{window_name}' 2>/dev/null)
else
  CURRENT_WINDOW=$(tmux display-message -p '#{window_name}' 2>/dev/null)
fi

# Lookup thread_ts and channel by session_id (window name) in sessions.json
# Prefer active sessions over terminated ones, and most recent if multiple matches
THREAD_TS=""
CHANNEL=""
if [[ -f "$SESSIONS_FILE" ]]; then
  SESSION_DATA=$(jq -r "
    [to_entries[] | select(.value.window == \"$SESSION_ID\" or .value.window == \"$CURRENT_WINDOW\")]
    | sort_by(.value.status == \"active\" | not) | sort_by(.value.created_at) | reverse
    | .[0] | \"\(.key)|\(.value.channel)\"
  " "$SESSIONS_FILE" 2>/dev/null)
  if [[ "$SESSION_DATA" != "null|null" && -n "$SESSION_DATA" ]]; then
    THREAD_TS=$(echo "$SESSION_DATA" | cut -d'|' -f1)
    CHANNEL=$(echo "$SESSION_DATA" | cut -d'|' -f2)
  fi
fi

# Fallback to environment variables or default channel
if [[ -z "$THREAD_TS" ]]; then
  THREAD_TS="${CLAUDE_THREAD_TS:-}"
fi
if [[ -z "$CHANNEL" ]]; then
  CHANNEL="${CLAUDE_SLACK_CHANNEL:-$DEFAULT_CHANNEL}"
fi

if [[ -z "$CHANNEL" ]]; then
  exit 1
fi

# Set per-session hash/cooldown files
SESSION_KEY="${THREAD_TS:-$CURRENT_WINDOW}"
LAST_SENT_HASH_FILE="/tmp/claude-slack-last-sent-hash-${SESSION_KEY}"
LAST_SENT_TIME_FILE="/tmp/claude-slack-last-sent-time-${SESSION_KEY}"

# Helper: Get actual DM channel ID from user ID (with caching)
get_reaction_channel() {
  local channel="$1"
  if [[ "$channel" == U* ]]; then
    # Check cache first
    local cache_file="/tmp/claude-slack-dm-cache-${channel}"
    if [[ -f "$cache_file" ]]; then
      cat "$cache_file"
      return
    fi
    # Resolve via API
    local dm_result dm_channel
    dm_result=$(curl -s -X POST "https://slack.com/api/conversations.open" \
      -H "Authorization: Bearer $BOT_TOKEN" \
      -H "Content-type: application/json" \
      -d "{\"users\": \"$channel\"}")
    dm_channel=$(echo "$dm_result" | jq -r '.channel.id // empty')
    # Cache the result
    [[ -n "$dm_channel" ]] && echo "$dm_channel" > "$cache_file"
    echo "$dm_channel"
  else
    echo "$channel"
  fi
}

# Helper: Remove eyes reaction from a message
remove_eyes_reaction() {
  local msg_ts="$1"
  [[ -z "$msg_ts" ]] && return

  local reaction_channel
  reaction_channel=$(get_reaction_channel "$CHANNEL")
  [[ -z "$reaction_channel" ]] && return

  curl -s -X POST "https://slack.com/api/reactions.remove" \
    -H "Authorization: Bearer $BOT_TOKEN" \
    -H "Content-type: application/json" \
    -d "{\"channel\": \"$reaction_channel\", \"name\": \"eyes\", \"timestamp\": \"$msg_ts\"}" > /dev/null
}

# Capture permission prompt from bottom of terminal
capture_permission_prompt() {
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    return
  fi

  local target_window="${SESSION_ID:-$CURRENT_WINDOW}"
  local content
  content=$(tmux capture-pane -t "$TMUX_SESSION:$target_window" -p -S -50 2>/dev/null)

  echo "$content" | awk '
    /● [A-Za-z]+\(/ {
      context = $0
      in_context = 1
      next
    }
    in_context && /^[[:space:]]+[0-9]+\./ { in_context = 0 }
    in_context && /\?/ { in_context = 0 }
    in_context {
      context = context "\n" $0
      next
    }
    /\?/ && !/http/ {
      prompt = $0
      options = ""
      capturing = 1
      next
    }
    capturing && (/[❯►].*[0-9]+\./ || /^[[:space:]]+[0-9]+\./ || /Esc to cancel/) {
      options = options "\n" $0
      next
    }
    END {
      if (prompt != "" && options != "") {
        if (context != "") { print context; print "" }
        print prompt
        print options
      }
    }
  '
}

# Capture response text
capture_response() {
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    return
  fi

  local target_window="${SESSION_ID:-$CURRENT_WINDOW}"
  local prev_content="" content="" stable_count=0

  for i in {1..10}; do
    sleep 0.3
    content=$(tmux capture-pane -t "$TMUX_SESSION:$target_window" -p -S -500 2>/dev/null)
    if [[ "$content" == "$prev_content" ]]; then
      stable_count=$((stable_count + 1))
      [[ $stable_count -ge 2 ]] && break
    else
      stable_count=0
      prev_content="$content"
    fi
  done

  echo "$content" | awk '
    /●/ { capture = $0; capturing = 1; next }
    /[✻✽✢✶·]/ || /^[─━]{20,}$/ || /^❯/ || /^\* .+…/ {
      if (capturing) { last_complete = capture; capturing = 0 }
      next
    }
    capturing { capture = capture "\n" $0 }
    END {
      if (last_complete != "") print last_complete
      else if (capturing && capture != "") print capture
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

# Update sessions.json atomically
update_session() {
  [[ -z "$THREAD_TS" || ! -f "$SESSIONS_FILE" ]] && return 1
  local jq_filter="$1"
  shift
  flock "$SESSIONS_LOCK" -c "
    TMP_FILE=\$(mktemp)
    jq --arg ts \"$THREAD_TS\" $* '$jq_filter' \"$SESSIONS_FILE\" > \"\$TMP_FILE\" && mv \"\$TMP_FILE\" \"$SESSIONS_FILE\"
  "
}

# Build message based on event type
INCLUDE_RESPONSE=false
INCLUDE_PROMPT=false

case "$EVENT_TYPE" in
  "Notification")
    NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.notification_type // .matcher // "unknown"')
    case "$NOTIFICATION_TYPE" in
      "idle_prompt")
        IDLE_TIME=$(date -Iseconds)
        update_session '.[$ts].status = "idle" | .[$ts].idle_since = $idle | del(.[$ts].pendingPermission)' "--arg idle \"$IDLE_TIME\""
        if [[ -n "$THREAD_TS" && -f "$SESSIONS_FILE" ]]; then
          LAST_MSG_TS=$(jq -r ".\"$THREAD_TS\".lastMessageTs // empty" "$SESSIONS_FILE")
          if [[ -n "$LAST_MSG_TS" ]]; then
            remove_eyes_reaction "$LAST_MSG_TS"
            update_session 'del(.[$ts].lastMessageTs)'
          fi
        fi
        exit 0
        ;;
      "permission_prompt")
        # Remove eyes since we're waiting for user input
        if [[ -n "$THREAD_TS" && -f "$SESSIONS_FILE" ]]; then
          LAST_MSG_TS=$(jq -r ".\"$THREAD_TS\".lastMessageTs // empty" "$SESSIONS_FILE")
          [[ -n "$LAST_MSG_TS" ]] && remove_eyes_reaction "$LAST_MSG_TS"
        fi
        # Mark session as having pending permission (for bridge to detect)
        update_session '.[$ts].pendingPermission = true'
        MESSAGE=":lock: Claude Code needs permission to proceed"
        INCLUDE_PROMPT=true
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  "PreCompact")
    MESSAGE=":hourglass_flowing_sand: Compacting conversation context..."
    ;;
  "Stop")
    # Rename window if still has temporary name
    if [[ "$CURRENT_WINDOW" == new-* && "$SESSION_ID" != "unknown" ]]; then
      tmux rename-window -t "$TMUX_SESSION:$CURRENT_WINDOW" "$SESSION_ID" 2>/dev/null
      CURRENT_WINDOW="$SESSION_ID"
      update_session '.[$ts].window = $sid | .[$ts].sessionId = $sidfull | .[$ts].status = "active" | del(.[$ts].pendingPermission)' \
        "--arg sid \"$SESSION_ID\" --arg sidfull \"$SESSION_ID_FULL\""
    else
      # Clear pendingPermission flag
      update_session 'del(.[$ts].pendingPermission)'
    fi

    # Remove eyes reaction
    if [[ -n "$THREAD_TS" && -f "$SESSIONS_FILE" ]]; then
      LAST_MSG_TS=$(jq -r ".\"$THREAD_TS\".lastMessageTs // empty" "$SESSIONS_FILE")
      if [[ -n "$LAST_MSG_TS" ]]; then
        remove_eyes_reaction "$LAST_MSG_TS"
        update_session 'del(.[$ts].lastMessageTs)'
      fi
    fi

    MESSAGE=":white_check_mark: Claude Code finished responding"
    INCLUDE_RESPONSE=true
    ;;
  "SubagentStop")
    MESSAGE=":robot_face: Claude Code subagent task completed"
    ;;
  *)
    MESSAGE=":speech_balloon: Claude Code event: $EVENT_TYPE"
    ;;
esac

# Build the full message
FULL_MESSAGE="$MESSAGE\n:file_folder: Project: \`$CWD\` | Session: \`$SESSION_ID\`"

if [[ "$INCLUDE_RESPONSE" == "true" ]]; then
  RESPONSE=$(capture_response)
  if [[ -n "$RESPONSE" ]]; then
    ESCAPED_RESPONSE=$(json_escape "$RESPONSE")
    FULL_MESSAGE="$FULL_MESSAGE\n\n\`\`\`\n$ESCAPED_RESPONSE\n\`\`\`"
  fi
fi

if [[ "$INCLUDE_PROMPT" == "true" ]]; then
  PROMPT=$(capture_permission_prompt)
  if [[ -n "$PROMPT" ]]; then
    ESCAPED_PROMPT=$(json_escape "$PROMPT")
    FULL_MESSAGE="$FULL_MESSAGE\n\n\`\`\`\n$ESCAPED_PROMPT\n\`\`\`"
  fi
fi

# Compute hash for deduplication
CONTENT_HASH=$(echo "$FULL_MESSAGE" | md5sum | cut -d' ' -f1)

# Skip duplicate/cooldown checks for permission prompts (always forward them)
if [[ "$INCLUDE_PROMPT" != "true" ]]; then
  if [[ -f "$LAST_SENT_HASH_FILE" ]]; then
    LAST_HASH=$(cat "$LAST_SENT_HASH_FILE" 2>/dev/null)
    [[ "$CONTENT_HASH" == "$LAST_HASH" ]] && exit 0
  fi

  if [[ -f "$LAST_SENT_TIME_FILE" ]]; then
    LAST_TIME=$(cat "$LAST_SENT_TIME_FILE" 2>/dev/null)
    NOW=$(date +%s)
    ELAPSED=$((NOW - LAST_TIME))
    [[ $ELAPSED -lt $COOLDOWN_SECONDS ]] && exit 0
  fi
fi

# Send message function
send_message() {
  local text="$1"
  local payload="{\"channel\": \"$CHANNEL\", \"text\": \"$text\", \"unfurl_links\": false"
  [[ -n "$THREAD_TS" ]] && payload="$payload, \"thread_ts\": \"$THREAD_TS\""
  payload="$payload}"

  curl -s -X POST "https://slack.com/api/chat.postMessage" \
    -H "Authorization: Bearer $BOT_TOKEN" \
    -H "Content-type: application/json" \
    -d "$payload" > /dev/null
}

# Split and send if too long
MAX_LENGTH=3500
MSG_LENGTH=${#FULL_MESSAGE}

if [[ $MSG_LENGTH -le $MAX_LENGTH ]]; then
  send_message "$FULL_MESSAGE"
else
  PART=1
  REMAINING="$FULL_MESSAGE"

  while [[ ${#REMAINING} -gt 0 ]]; do
    if [[ ${#REMAINING} -le $MAX_LENGTH ]]; then
      CHUNK="$REMAINING"
      REMAINING=""
    else
      CHUNK="${REMAINING:0:$MAX_LENGTH}"
      LAST_NEWLINE=$(echo "$CHUNK" | grep -bo '\\n' | tail -1 | cut -d: -f1)
      if [[ -n "$LAST_NEWLINE" && $LAST_NEWLINE -gt 1000 ]]; then
        CHUNK="${REMAINING:0:$LAST_NEWLINE}"
        REMAINING="${REMAINING:$LAST_NEWLINE}"
      else
        REMAINING="${REMAINING:$MAX_LENGTH}"
      fi
    fi

    if [[ $PART -eq 1 && -n "$REMAINING" ]]; then
      CHUNK="$CHUNK\\n_(continued...)_"
    elif [[ $PART -gt 1 ]]; then
      CHUNK="_(part $PART)_\\n$CHUNK"
    fi

    send_message "$CHUNK"
    PART=$((PART + 1))
    [[ -n "$REMAINING" ]] && sleep 0.2
  done
fi

# Update session activity
ACTIVITY_TIME=$(date -Iseconds)
update_session '.[$ts].last_activity = $activity' "--arg activity \"$ACTIVITY_TIME\""

# Store hash and timestamp
echo "$CONTENT_HASH" > "$LAST_SENT_HASH_FILE"
date +%s > "$LAST_SENT_TIME_FILE"

exit 0
