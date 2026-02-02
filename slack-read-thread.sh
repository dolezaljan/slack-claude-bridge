#!/bin/bash
# Read a Slack thread and output its messages
# Usage: slack-read-thread.sh [thread_ts]
# If no thread_ts provided, detects from environment or sessions.json

CONFIG_FILE="$HOME/.claude/slack-bridge/config.json"
SESSIONS_FILE="/tmp/claude-slack-sessions.json"

# Load bot token from config
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

BOT_TOKEN=$(jq -r '.botToken // empty' "$CONFIG_FILE")

if [[ -z "$BOT_TOKEN" ]]; then
  echo "Error: botToken not found in config" >&2
  exit 1
fi

# Get thread_ts and channel
THREAD_TS="$1"
CHANNEL=""

if [[ -z "$THREAD_TS" ]]; then
  # Try environment variables first (set by bridge when creating session)
  THREAD_TS="${CLAUDE_THREAD_TS:-}"
  CHANNEL="${CLAUDE_SLACK_CHANNEL:-}"
fi

if [[ -z "$THREAD_TS" && -f "$SESSIONS_FILE" ]]; then
  # Try to find session by current tmux window name
  CURRENT_WINDOW=$(tmux display-message -p '#{window_name}' 2>/dev/null)
  if [[ -n "$CURRENT_WINDOW" ]]; then
    SESSION_DATA=$(jq -r "to_entries[] | select(.value.window == \"$CURRENT_WINDOW\") | \"\(.key)|\(.value.channel)\"" "$SESSIONS_FILE" 2>/dev/null | head -1)
    if [[ -n "$SESSION_DATA" ]]; then
      THREAD_TS=$(echo "$SESSION_DATA" | cut -d'|' -f1)
      CHANNEL=$(echo "$SESSION_DATA" | cut -d'|' -f2)
    fi
  fi
fi

if [[ -z "$THREAD_TS" ]]; then
  echo "Error: No thread_ts provided and no thread context found" >&2
  echo "Usage: $0 [thread_ts]" >&2
  echo "" >&2
  echo "Thread detection tries (in order):" >&2
  echo "  1. Command line argument" >&2
  echo "  2. CLAUDE_THREAD_TS environment variable" >&2
  echo "  3. Current tmux window name lookup in sessions.json" >&2
  exit 1
fi

if [[ -z "$CHANNEL" ]]; then
  # Try to get channel from config as fallback
  CHANNEL=$(jq -r '.notifyChannel // empty' "$CONFIG_FILE")
fi

if [[ -z "$CHANNEL" ]]; then
  echo "Error: No channel found in context or config" >&2
  exit 1
fi

# Fetch thread replies using Slack API
RESPONSE=$(curl -s -X GET "https://slack.com/api/conversations.replies?channel=${CHANNEL}&ts=${THREAD_TS}&limit=100" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-type: application/json")

# Check for errors
OK=$(echo "$RESPONSE" | jq -r '.ok')
if [[ "$OK" != "true" ]]; then
  ERROR=$(echo "$RESPONSE" | jq -r '.error // "unknown error"')
  echo "Error from Slack API: $ERROR" >&2
  exit 1
fi

# Format and output messages
echo "$RESPONSE" | jq -r '.messages[] | "[\(.ts | tonumber | strftime("%Y-%m-%d %H:%M:%S"))] \(.user // .bot_id // "unknown"): \(.text)"'
