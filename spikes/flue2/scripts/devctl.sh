#!/bin/sh
# usage: devctl.sh start|kill  (kills workerd too)
LOG=${LOG:-/private/tmp/claude-501/-Users-cshyang-Documents-Coding-Repositories-Morehands/8f7ccf44-2d16-47b5-abf1-b07d46ff0b75/scratchpad/dev2.log}
case "$1" in
  start) nohup npx vite dev --port 5199 >> "$LOG" 2>&1 & ;;
  kill) pkill -9 -f workerd; pkill -9 -f "vite dev" ;;
esac
