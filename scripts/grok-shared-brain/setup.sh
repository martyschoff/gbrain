#!/bin/bash
# Shared-brain runbook driver. It does not install Bun, gbrain, or Tailscale,
# and it does not run `tailscale funnel`.
# The expected hostname is read from an untracked file outside the repo.
# Format (one assignment, placeholder shown):
#   GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>
set -euo pipefail

HOST_ENV="${HOME}/.gbrain/serve/host.env"
if [ ! -f "$HOST_ENV" ]; then
  echo "refusing: missing ${HOST_ENV}. Create it with one line: GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>" >&2
  exit 1
fi

expected=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*) continue ;;
    GBRAIN_EXPECTED_HOST=*) expected=${line#GBRAIN_EXPECTED_HOST=} ;;
  esac
done < "$HOST_ENV"
case "$expected" in
  \"*\") expected=${expected#\"}; expected=${expected%\"} ;;
  \'*\') expected=${expected#\'}; expected=${expected%\'} ;;
esac
if [ -z "$expected" ]; then
  echo "refusing: GBRAIN_EXPECTED_HOST is missing from ${HOST_ENV}" >&2
  exit 1
fi

host=$(hostname -s)
if [ "$host" != "$expected" ]; then
  echo "refusing: this machine does not match GBRAIN_EXPECTED_HOST in ${HOST_ENV}" >&2
  exit 1
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
