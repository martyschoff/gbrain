#!/bin/bash
# Hostname guard first, then one PASS or FAIL line per check. Exits non-zero if any check fails.
set -u

failed=0
check() {
  local name=$1
  shift
  if "$@"; then
    echo "PASS ${name}"
  else
    echo "FAIL ${name}"
    failed=1
  fi
}

HOST_ENV="${HOME}/.gbrain/serve/host.env"
host_ok=0
if [ -f "$HOST_ENV" ]; then
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
  host=$(hostname -s)
  if [ -n "$expected" ] && [ "$host" = "$expected" ]; then
    host_ok=1
  fi
fi
if [ "$host_ok" -eq 1 ]; then
  echo "PASS hostname"
else
  echo "FAIL hostname"
  failed=1
fi

CFG="${HOME}/.gbrain/bot-loader/config.json"
summary="${HOME}/.gbrain/bot-loader/last-summary.txt"
finance=""
if [ -f "$CFG" ]; then
  parsed=$(python3 - "$CFG" <<'PY'
import json, os, sys
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
share = cfg.get("share_root", "")
if isinstance(share, str) and share.startswith("~"):
    share = os.path.expanduser(share)
summary = cfg.get("summary_path", "")
if not isinstance(summary, str) or summary == "":
    summary = os.path.expanduser("~/.gbrain/bot-loader/last-summary.txt")
elif summary.startswith("~"):
    summary = os.path.expanduser(summary)
finance = ""
for group in cfg.get("groups", []):
    if isinstance(group, dict) and group.get("source") == "finance":
        target = group.get("target_root", "")
        if isinstance(target, str):
            target = target.replace("<share>", share)
            if target.startswith("~"):
                target = os.path.expanduser(target)
            finance = target
print(summary)
print(finance)
PY
)
  summary=$(printf '%s\n' "$parsed" | sed -n '1p')
  finance=$(printf '%s\n' "$parsed" | sed -n '2p')
fi

launchd_loaded() {
  command -v launchctl >/dev/null 2>&1 || return 1
  local uid domain
  uid=$(id -u)
  domain="gui/${uid}/com.gbrain.bot-loader"
  launchctl print "$domain" >/dev/null 2>&1
}
check launchd launchd_loaded

status_ok() {
  [ -f "$summary" ] || return 1
  grep -q '^bot-loader: ok$' "$summary" || return 1
  local mtime now age
  mtime=$(stat -c %Y "$summary" 2>/dev/null || stat -f %m "$summary") || return 1
  now=$(date +%s)
  age=$((now - mtime))
  [ "$age" -ge 0 ] && [ "$age" -lt 129600 ]
}
check "status fresh" status_ok

finance_clean() {
  [ -n "$finance" ] || return 1
  if [ ! -e "${finance}/.git" ]; then
    return 0
  fi
  local remotes
  remotes=$(git -C "$finance" remote 2>/dev/null) || return 1
  [ -z "$remotes" ]
}
check "finance remotes" finance_clean

echo "---- counts ----"
if [ -f "$summary" ]; then
  grep -E '^(bot |source )' "$summary" || true
else
  echo "no summary yet"
fi

exit "$failed"
