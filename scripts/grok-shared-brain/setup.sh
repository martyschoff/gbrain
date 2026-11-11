#!/bin/bash
# Shared-brain runbook driver. It does not install Bun, gbrain, or Tailscale,
# and it does not run `tailscale funnel`.
set -euo pipefail

if [ "${GBRAIN_SHARED_BRAIN_TEST:-}" != "1" ]; then
  host=$(hostname -s)
  if [ "$host" != "Martins-Mac-mini" ]; then
    echo "Wrong machine: $host" >&2
    exit 1
  fi
fi

echo "Funnel is OFF. This script does not publish Tailscale Funnel."
echo "The operator enables it in person with:"
echo "tailscale funnel --bg 8767"
echo "Runtime the operator installs in person: Bun 1.4.4 or newer, from https://bun.sh/install"
echo "Token file (hashes only, outside the repo): ~/.gbrain/serve/funnel-tokens.json"

if [ "${GBRAIN_SHARED_APPLY_STEP4:-}" = "1" ]; then
  HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
  bash "$HERE/step4-sources.sh"
fi
