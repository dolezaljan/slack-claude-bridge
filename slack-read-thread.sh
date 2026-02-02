#!/bin/bash
# Read a Slack thread and output its messages
# Usage: slack-read-thread.sh [thread_ts]
# If no thread_ts provided, reads from current thread context

CONFIG_FILE="$HOME/.claude/slack-bridge/config.json"
THREAD_CONTEXT_FILE="/tmp/claude-slack-thread-context.json"

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

# Get thread_ts and channel from argument or context file
THREAD_TS="$1"
CHANNEL=""

if [[ -z "$THREAD_TS" ]]; then
  # Try to read from context file
  if [[ -f "$THREAD_CONTEXT_FILE" ]]; then
    THREAD_TS=$(jq -r '.thread_ts // empty' "$THREAD_CONTEXT_FILE")
    CHANNEL=$(jq -r '.channel // empty' "$THREAD_CONTEXT_FILE")
  fi
fi

if [[ -z "$THREAD_TS" ]]; then
  echo "Error: No thread_ts provided and no thread context found" >&2
  echo "Usage: $0 [thread_ts]" >&2
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
