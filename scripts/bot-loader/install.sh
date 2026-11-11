#!/bin/bash
# Hostname guard first. A mismatch refuses the install.
# The expected hostname is one untracked line in ~/.gbrain/serve/host.env:
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

if [ -n "${GBRAIN_REPO:-}" ]; then
  REPO=$GBRAIN_REPO
elif [ -f "$0" ] && [ "$(basename "$0")" = "install.sh" ]; then
  REPO=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
else
  REPO="${HOME}/personalgrok/gbrain"
fi

CFG="${HOME}/.gbrain/bot-loader/config.json"
if [ ! -f "$CFG" ]; then
  mkdir -p "${HOME}/.gbrain/bot-loader"
  cp "$REPO/docs/grok/bot-loader/config.example.json" "$CFG"
  chmod 600 "$CFG"
fi

SHARE=$(python3 -c 'import json,os,sys
c=json.load(open(sys.argv[1], encoding="utf-8"))
p=c["share_root"]
print(os.path.expanduser(p) if isinstance(p, str) and p.startswith("~") else p)' "$CFG")
if [ -z "$SHARE" ] || [ ! -d "$SHARE" ]; then
  echo "bot-loader: share root is not a mounted filesystem; nothing else was changed" >&2
  exit 1
fi
dev=$(stat -L -c %d "$SHARE" 2>/dev/null || stat -L -f %d "$SHARE")
parent=$(stat -L -c %d "$(dirname "$SHARE")" 2>/dev/null || stat -L -f %d "$(dirname "$SHARE")")
if [ "$dev" = "$parent" ]; then
  echo "bot-loader: share root is not a mounted filesystem; nothing else was changed" >&2
  exit 1
fi

GBRAIN_BIN=""
if command -v gbrain >/dev/null 2>&1; then
  GBRAIN_BIN=$(command -v gbrain)
elif [ -x "${HOME}/.bun/bin/gbrain" ]; then
  GBRAIN_BIN="${HOME}/.bun/bin/gbrain"
fi
if [ -z "$GBRAIN_BIN" ]; then
  echo "refusing: gbrain was not found with command -v or at ${HOME}/.bun/bin/gbrain" >&2
  exit 1
fi
GBRAIN_BIN=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$GBRAIN_BIN")
case "$GBRAIN_BIN" in
  /*) ;;
  *) echo "refusing: resolved gbrain path is not absolute (${GBRAIN_BIN})" >&2; exit 1 ;;
esac
if [ ! -x "$GBRAIN_BIN" ]; then
  echo "refusing: gbrain is not executable at ${GBRAIN_BIN}" >&2
  exit 1
fi
python3 - "$CFG" "$GBRAIN_BIN" <<'PY'
import os, re, sys
path, binary = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
if re.search(r'"gbrain_bin"\s*:', text):
    text2, _ = re.subn(r'("gbrain_bin"\s*:\s*")[^"]*"', lambda m: m.group(1) + binary + '"', text, count=1)
else:
    text2 = text.replace("{", '{\n  "gbrain_bin": "%s",' % binary, 1)
if text2 != text:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
PY

BUN="${HOME}/.bun/bin/bun"
if [ ! -x "$BUN" ]; then
  echo "refusing: bun is not executable at ${BUN}" >&2
  exit 1
fi
export PATH="${HOME}/.bun/bin:${PATH}"

FIN="${SHARE}/personalgrok/gbrain/finance"
if [ -e "${FIN}/.git" ]; then
  echo "refusing: finance directory has git metadata; not registering it" >&2
  exit 1
fi
mkdir -p "$FIN"
set +e
add_out=$("$GBRAIN_BIN" sources add finance --path "$FIN" --name finance --no-federated --force --json 2>&1)
add_status=$?
set -e
if [ "$add_status" -ne 0 ]; then
  case "$add_out" in
    *"already registered"*|*"already exists"*) ;;
    *) printf '%s\n' "$add_out" >&2; exit 1 ;;
  esac
fi

AGENT="${HOME}/Library/LaunchAgents"
mkdir -p "$AGENT" "${HOME}/Library/Logs"
RENDERED="${AGENT}/com.gbrain.bot-loader.plist"
LOADER_PATH="${HOME}/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"
sed \
  -e "s|__BUN__|${BUN}|g" \
  -e "s|__REPO__|${REPO}|g" \
  -e "s|__HOME__|${HOME}|g" \
  -e "s|__PATH__|${LOADER_PATH}|g" \
  "$REPO/scripts/bot-loader/com.gbrain.bot-loader.plist" > "$RENDERED"
if grep -q '__' "$RENDERED"; then
  echo "refusing: rendered plist still has placeholders" >&2
  exit 1
fi
plutil -lint "$RENDERED"
uid=$(id -u)
launchctl bootout "gui/${uid}/com.gbrain.bot-loader" || true
launchctl bootstrap "gui/${uid}" "$RENDERED"
example_share=0
if python3 - "$CFG" "$HOME" <<'PY'
import json, os, sys
path, home = sys.argv[1], sys.argv[2]
cfg = json.load(open(path, encoding="utf-8"))
if cfg.get("share_root_confirmed") is True:
    sys.exit(1)
share = cfg.get("share_root")
if not isinstance(share, str):
    sys.exit(1)
expanded = os.path.abspath(os.path.expanduser(share))
example = os.path.abspath(os.path.join(home, "mnt/netfs"))
same = False
if os.path.exists(expanded) and os.path.exists(example):
    same = os.path.realpath(expanded) == os.path.realpath(example)
if share == "~/mnt/netfs" or expanded == example or same:
    sys.exit(0)
sys.exit(1)
PY
then
  example_share=1
fi
if grep -q '__SET_ME__' "$CFG" || grep -Eq '"bot-a"|"bot-b"|"fin-bot"' "$CFG" || [ "$example_share" -eq 1 ]; then
  echo "edit ${CFG}, then rerun this block"
  exit 0
fi
"$BUN" "$REPO/scripts/bot-loader/cli.ts" --config "$CFG"
