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
  # Create session with bridge window at position 0
  tmux new-session -d -s "$TMUX_SESSION" -n bridge -c "$BRIDGE_DIR"
  tmux send-keys -t "$TMUX_SESSION:bridge" "node bridge.js 2>&1 | tee $LOG_FILE" Enter
  echo -e "${GREEN}✓ Created tmux session with bridge at window 0${NC}"
else
  echo -e "${YELLOW}tmux session '$TMUX_SESSION' exists${NC}"

  # Check if bridge window already exists
  if tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' | grep -q '^bridge$'; then
    echo -e "${YELLOW}Bridge window exists, starting process...${NC}"
    # Start the bridge in the existing window (in case it died)
    tmux send-keys -t "$TMUX_SESSION:bridge" "node bridge.js 2>&1 | tee $LOG_FILE" Enter
  else
    # Create new window for bridge
    tmux new-window -t "$TMUX_SESSION": -n bridge -c "$BRIDGE_DIR"

    # Get the current index of the bridge window
    BRIDGE_IDX=$(tmux list-windows -t "$TMUX_SESSION" -F '#{window_index} #{window_name}' | grep ' bridge$' | cut -d' ' -f1)

    # Move bridge window to position 0 (swap if 0 exists, otherwise move)
    if tmux list-windows -t "$TMUX_SESSION" -F '#{window_index}' | grep -q '^0$'; then
      # Window 0 exists, swap with it
      tmux swap-window -s "$TMUX_SESSION:$BRIDGE_IDX" -t "$TMUX_SESSION:0"
    else
      # No window 0, just move
      tmux move-window -s "$TMUX_SESSION:$BRIDGE_IDX" -t "$TMUX_SESSION:0"
    fi

    # Start the bridge in the window
    tmux send-keys -t "$TMUX_SESSION:bridge" "node bridge.js 2>&1 | tee $LOG_FILE" Enter
    echo -e "${GREEN}✓ Created bridge window at position 0${NC}"
  fi
fi

# Wait and check if it started
sleep 2
if pgrep -f "node bridge.js" > /dev/null; then
  echo -e "${GREEN}✓ Bridge started${NC}"
  echo ""
  echo "Log file: $LOG_FILE"
  echo "tmux:     tmux attach -t $TMUX_SESSION"
  echo ""
  tail -15 "$LOG_FILE"
  echo ""
  echo "Commands:"
  echo "  attach:  tmux attach -t $TMUX_SESSION"
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
