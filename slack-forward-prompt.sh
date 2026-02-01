#!/bin/bash
# Forward user prompts from local Claude session to Slack thread
# Used as a UserPromptSubmit hook
#
# Checks if the message was already sent from Slack (via bridge) to avoid echo.
# Only forwards messages typed locally.
#
# Note: Images/files pasted into Claude are NOT exposed to hooks, so they
# cannot be automatically forwarded. Use slack-upload.sh manually for files.

CONFIG_FILE="$HOME/.claude/slack-bridge/config.json"
SESSIONS_FILE="/tmp/claude-slack-sessions.json"
TMUX_SESSION="${CLAUDE_TMUX_SESSION:-claude}"

# Read hook input from stdin
INPUT=$(cat)

# Extract prompt from hook input
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')
if [[ -z "$PROMPT" ]]; then
  exit 0
fi

# Check if we're in the tmux session
if [[ -z "$TMUX" ]]; then
  exit 0
fi

CURRENT_SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null)
if [[ "$CURRENT_SESSION" != "$TMUX_SESSION" ]]; then
  exit 0
fi

# Get thread_ts from environment or sessions.json
THREAD_TS="${CLAUDE_THREAD_TS:-}"
CHANNEL="${CLAUDE_SLACK_CHANNEL:-}"

if [[ -z "$THREAD_TS" || -z "$CHANNEL" ]] && [[ -f "$SESSIONS_FILE" ]]; then
  if [[ -n "$TMUX_PANE" ]]; then
    CURRENT_WINDOW=$(tmux display-message -t "$TMUX_PANE" -p '#{window_name}' 2>/dev/null)
  else
    CURRENT_WINDOW=$(tmux display-message -p '#{window_name}' 2>/dev/null)
  fi

  if [[ -n "$CURRENT_WINDOW" ]]; then
    SESSION_DATA=$(jq -r "to_entries[] | select(.value.window == \"$CURRENT_WINDOW\") | \"\(.key)|\(.value.channel)\"" "$SESSIONS_FILE" | head -1)
    if [[ -n "$SESSION_DATA" ]]; then
      THREAD_TS=$(echo "$SESSION_DATA" | cut -d'|' -f1)
      CHANNEL=$(echo "$SESSION_DATA" | cut -d'|' -f2)
    fi
  fi
fi

# No thread context - not a bridge session
if [[ -z "$THREAD_TS" || -z "$CHANNEL" ]]; then
  exit 0
fi

# Check if this message came from Slack (bridge wrote it to pending file)
PENDING_FILE="/tmp/claude-slack-pending-${THREAD_TS}"
if [[ -f "$PENDING_FILE" ]]; then
  PENDING_HASH=$(cat "$PENDING_FILE")
  # Trim whitespace before hashing to match bridge's hash
  TRIMMED_PROMPT=$(echo "$PROMPT" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  PROMPT_HASH=$(echo -n "$TRIMMED_PROMPT" | md5sum | cut -d' ' -f1)

  if [[ "$PENDING_HASH" == "$PROMPT_HASH" ]]; then
    # Message came from Slack - don't echo back, just clear the pending file
    rm -f "$PENDING_FILE"
    exit 0
  fi
  # Different message - clear stale pending file
  rm -f "$PENDING_FILE"
fi

# Load bot token
if [[ ! -f "$CONFIG_FILE" ]]; then
  exit 0
fi

BOT_TOKEN=$(jq -r '.botToken // empty' "$CONFIG_FILE")
if [[ -z "$BOT_TOKEN" ]]; then
  exit 0
fi

# Escape for JSON
json_escape() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//$'\n'/\\n}"
  text="${text//$'\r'/}"
  text="${text//$'\t'/  }"
  echo "$text"
}

# Format message - show it's from local terminal
ESCAPED_PROMPT=$(json_escape "$PROMPT")
MESSAGE=":computer: *Local input:*\n\`\`\`\n${ESCAPED_PROMPT}\n\`\`\`"

# Post to Slack thread
curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-type: application/json" \
  -d "{\"channel\": \"$CHANNEL\", \"thread_ts\": \"$THREAD_TS\", \"text\": \"$MESSAGE\", \"unfurl_links\": false}" > /dev/null

exit 0
