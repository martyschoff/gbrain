#!/bin/bash
# Remove the nightly loader agent. Leaves ~/.gbrain/bot-loader and the share untouched.
set -euo pipefail
uid=$(id -u)
launchctl bootout "gui/${uid}/com.gbrain.bot-loader" || true
rm -f "${HOME}/Library/LaunchAgents/com.gbrain.bot-loader.plist"
echo "uninstalled com.gbrain.bot-loader"
