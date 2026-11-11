#!/bin/bash
# One verify command: launchd state, the last summary, and the page-count lines.
set -euo pipefail
uid=$(id -u)
domain="gui/${uid}/com.gbrain.bot-loader"
echo "---- launchctl ----"
if command -v launchctl >/dev/null 2>&1; then
  launchctl print "$domain" 2>&1 | grep -E 'state =|pid =|path =' || echo "launchctl: ${domain} is not loaded"
else
  echo "launchctl: not available"
fi
summary="${HOME}/.gbrain/bot-loader/last-summary.txt"
echo "---- last summary ----"
if [ -f "$summary" ]; then
  cat "$summary"
  echo "---- page counts ----"
  grep -E '^(bot |source )' "$summary" || true
else
  echo "no summary yet"
fi
