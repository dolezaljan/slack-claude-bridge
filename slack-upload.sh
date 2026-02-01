#!/bin/bash
# Upload a file to Slack thread
# Usage: slack-upload.sh <file> [message]
#
# Requires environment variables (set automatically by bridge):
#   CLAUDE_THREAD_TS - Thread timestamp to upload to
#   CLAUDE_SLACK_CHANNEL - Channel ID
#
# Or reads from sessions.json based on current tmux window

CONFIG_FILE="$HOME/.claude/slack-bridge/config.json"
SESSIONS_FILE="/tmp/claude-slack-sessions.json"

# Check arguments
if [[ -z "$1" ]]; then
  echo "Usage: slack-upload.sh <file> [message]" >&2
  echo "Upload a file to the current Slack thread" >&2
  exit 1
fi

FILE_PATH="$1"
MESSAGE="${2:-}"

# Validate file exists
if [[ ! -f "$FILE_PATH" ]]; then
  echo "Error: File not found: $FILE_PATH" >&2
  exit 1
fi

# Load bot token
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

BOT_TOKEN=$(jq -r '.botToken // empty' "$CONFIG_FILE")
if [[ -z "$BOT_TOKEN" ]]; then
  echo "Error: botToken not found in config" >&2
  exit 1
fi

# Get thread_ts and channel from environment or sessions file
THREAD_TS="${CLAUDE_THREAD_TS:-}"
CHANNEL="${CLAUDE_SLACK_CHANNEL:-}"

# If not in environment, try to find from sessions.json based on tmux window
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

if [[ -z "$THREAD_TS" ]]; then
  echo "Error: Could not determine Slack thread. Not in a bridge session?" >&2
  exit 1
fi

if [[ -z "$CHANNEL" ]]; then
  echo "Error: Could not determine Slack channel" >&2
  exit 1
fi

# Get file info
FILENAME=$(basename "$FILE_PATH")
FILESIZE=$(stat --printf="%s" "$FILE_PATH" 2>/dev/null || stat -f%z "$FILE_PATH" 2>/dev/null)

echo "Uploading: $FILENAME ($FILESIZE bytes)"

# Step 1: Get upload URL
UPLOAD_RESP=$(curl -s \
  -F "filename=$FILENAME" \
  -F "length=$FILESIZE" \
  -H "Authorization: Bearer $BOT_TOKEN" \
  https://slack.com/api/files.getUploadURLExternal)

OK=$(echo "$UPLOAD_RESP" | jq -r '.ok')
if [[ "$OK" != "true" ]]; then
  ERROR=$(echo "$UPLOAD_RESP" | jq -r '.error // "unknown error"')
  echo "Error getting upload URL: $ERROR" >&2
  exit 1
fi

UPLOAD_URL=$(echo "$UPLOAD_RESP" | jq -r '.upload_url')
FILE_ID=$(echo "$UPLOAD_RESP" | jq -r '.file_id')

# Step 2: Upload file to the URL
curl -s -F "file=@$FILE_PATH" "$UPLOAD_URL" > /dev/null

# Step 3: Complete the upload and share to channel/thread
COMPLETE_ARGS=(
  -F "files=[{\"id\":\"$FILE_ID\"}]"
  -F "channel_id=$CHANNEL"
  -F "thread_ts=$THREAD_TS"
  -H "Authorization: Bearer $BOT_TOKEN"
)

if [[ -n "$MESSAGE" ]]; then
  COMPLETE_ARGS+=(-F "initial_comment=$MESSAGE")
fi

COMPLETE_RESP=$(curl -s "${COMPLETE_ARGS[@]}" https://slack.com/api/files.completeUploadExternal)

OK=$(echo "$COMPLETE_RESP" | jq -r '.ok')
if [[ "$OK" != "true" ]]; then
  ERROR=$(echo "$COMPLETE_RESP" | jq -r '.error // "unknown error"')
  echo "Error completing upload: $ERROR" >&2
  exit 1
fi

echo "File uploaded successfully"
PERMALINK=$(echo "$COMPLETE_RESP" | jq -r '.files[0].permalink // empty')
[[ -n "$PERMALINK" ]] && echo "Link: $PERMALINK"
