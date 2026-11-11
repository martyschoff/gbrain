#!/bin/bash
# Create the four source checkouts and commit README.md with a repo-local
# git identity. A stale index.lock is left in place unless the clearer is
# re-run with --force. This script does not pass --force.
set -euo pipefail

ROOT="${GBRAIN_MLSFS_ROOT:-}"
if [ -z "$ROOT" ]; then
  echo "Set GBRAIN_MLSFS_ROOT to the mlsfs mount path. The docs keep the placeholder /Volumes/<share>/personalgrok/gbrain." >&2
  exit 1
fi
case "$ROOT" in
  *"<"*|*">"*) echo "GBRAIN_MLSFS_ROOT still contains a placeholder." >&2; exit 1 ;;
esac

HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)

clear_lock() {
  dir="$1"
  if [ -e "$dir/.git/index.lock" ]; then
    bun "$HERE/cli-clear-index-lock.ts" "$dir"
  fi
}

init_source() {
  s="$1"
  dir="$ROOT/$s"
  mkdir -p "$dir"
  if [ ! -d "$dir/.git" ]; then
    git -C "$dir" init
  fi
  clear_lock "$dir"
  if [ ! -f "$dir/README.md" ]; then
    printf '# %s\n' "$s" > "$dir/README.md"
  fi
  git -C "$dir" add README.md
  if git -C "$dir" diff --cached --quiet; then
    return 0
  fi
  git -C "$dir" -c user.name=gbrain -c user.email=gbrain@localhost commit -m "initial $s"
}

for s in personal business hermes shared; do
  init_source "$s"
done
echo "step4 ok: $ROOT"
