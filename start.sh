#!/bin/bash
# Claude Code Slack Bridge - Start Script

BRIDGE_DIR="$HOME/.claude/slack-bridge"
TMUX_SESSION="claude"
LOG_FILE="/tmp/slack-bridge.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Claude Code Slack Bridge"
echo "========================"
echo ""

# Check if bridge is already running
if pgrep -f "node bridge.js" > /dev/null; then
  echo -e "${YELLOW}Bridge is already running${NC}"
  echo ""
  echo "Recent log:"
  tail -10 "$LOG_FILE"
  echo ""
  echo "Commands:"
  echo "  stop:    pkill -f 'node bridge.js'"
  echo "  logs:    tail -f $LOG_FILE"
  echo "  restart: $0 --restart"

  if [[ "$1" == "--restart" ]]; then
    echo ""
    echo -e "${YELLOW}Restarting...${NC}"
    pkill -f "node bridge.js"
    sleep 1
  else
    exit 0
  fi
fi

# Check if tmux session exists
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo -e "${YELLOW}Creating tmux session '$TMUX_SESSION'...${NC}"
  tmux new-session -d -s "$TMUX_SESSION"
  echo -e "${GREEN}✓ Created${NC}"
fi

# Start the bridge
echo "Starting bridge..."
cd "$BRIDGE_DIR"
nohup node bridge.js > "$LOG_FILE" 2>&1 &

# Wait and check if it started
sleep 2
if pgrep -f "node bridge.js" > /dev/null; then
  echo -e "${GREEN}✓ Bridge started${NC}"
  echo ""
  echo "Log file: $LOG_FILE"
  echo ""
  tail -15 "$LOG_FILE"
  echo ""
  echo "Commands:"
  echo "  logs:    tail -f $LOG_FILE"
  echo "  stop:    pkill -f 'node bridge.js'"
  echo "  restart: $0 --restart"
else
  echo -e "${RED}✗ Failed to start${NC}"
  echo ""
  echo "Check log:"
  cat "$LOG_FILE"
  exit 1
fi
