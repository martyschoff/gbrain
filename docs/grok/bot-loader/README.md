# Bot knowledge loader

**Say to your agent:** *"Install the nightly bot-knowledge loader from this checkout, keep the real bot list in the local config, and do not push those pages to a git remote."*

The loader reads text from folders you list in a local config, writes one markdown page per file onto the share, and imports the pages that changed. The repo ships placeholders only (`bot-a`, `bot-b`, `fin-bot`). The real bot list, share path, and any extra folders live in `~/.gbrain/bot-loader/config.json`, which is never committed. The list can be any length. Nothing in the loader assumes a fixed number of bots.

Hosted GBrain is at [gbrain.io](https://gbrain.io/cli?ref=agents-md). This loader is the self-hosted path for a brain that already runs on the machine.

## Install or upgrade

Upgrade is this same block after `git pull` on this branch. It runs in a subshell. The first check is the hostname guard. It copies the example config only when `~/.gbrain/bot-loader/config.json` is missing, and it never overwrites an existing config. Put the real config in place before the first run if the example is not what you want loaded.

```bash
(
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
dev=$(stat -c %d "$SHARE" 2>/dev/null || stat -f %d "$SHARE")
parent=$(stat -c %d "$(dirname "$SHARE")" 2>/dev/null || stat -f %d "$(dirname "$SHARE")")
if [ "$dev" = "$parent" ]; then
  echo "bot-loader: share root is not a mounted filesystem; nothing else was changed" >&2
  exit 1
fi

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
add_out=$(gbrain sources add finance --path "$FIN" --name finance --no-federated --force --json 2>&1)
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
sed \
  -e "s|__BUN__|${BUN}|g" \
  -e "s|__REPO__|${REPO}|g" \
  -e "s|__HOME__|${HOME}|g" \
  "$REPO/scripts/bot-loader/com.gbrain.bot-loader.plist" > "$RENDERED"
if grep -q '__' "$RENDERED"; then
  echo "refusing: rendered plist still has placeholders" >&2
  exit 1
fi
plutil -lint "$RENDERED"
uid=$(id -u)
launchctl bootout "gui/${uid}/com.gbrain.bot-loader" || true
launchctl bootstrap "gui/${uid}" "$RENDERED"
"$BUN" "$REPO/scripts/bot-loader/cli.ts" --config "$CFG"
)
```

## Verify

```bash
bash "$HOME/personalgrok/gbrain/scripts/bot-loader/verify.sh"
```

That prints the `launchctl` state of `com.gbrain.bot-loader`, the last summary, and the page-count lines from that summary.

## Uninstall

```bash
bash "$HOME/personalgrok/gbrain/scripts/bot-loader/uninstall.sh"
```

Uninstall removes the LaunchAgent plist. It leaves `~/.gbrain/bot-loader` and the pages on the share in place.

## macOS privacy

A LaunchAgent runs `bun` outside your terminal. To read an SMB share, the binary's real path needs Full Disk Access, including Network Volumes. Print that path and add it in System Settings:

```bash
realpath "$HOME/.bun/bin/bun"
```

## What a run does

For each bot in the local config, in each group:

1. Read the bot's input folders. Missing optional folders, a missing `_box-export` directory, and a stale or missing `EXPORTED_AT` stamp (older than `box_export_max_age_hours`, default 36) are warnings. The run still reads the other folders and exits 0. The only hard stop before any write is a share root that is missing or not a real mount (its device id matches its parent). A hostname mismatch logs and exits 0 without writing. A second overlapping run exits non-zero on the lock file.
2. Keep `.md`, `.txt`, `.json`, and the group's extension list, under `max_bytes` (default 1 MiB). `.csv` is on the finance group's default list and becomes a markdown table. Data rows stop at `csv_max_rows` (default 500) with a truncation note. Images, audio, video, archives, and database files (`.db`, `.sqlite`, `-wal`, `-shm`) are skipped even if a group lists them. Directories named `audit`, `audits`, `audit-logs`, or `automations` are not entered. Sources are not modified, moved, or deleted.
3. Skip secrets by file name (`.env*`, `*token*`, `*secret*`, `*credential*`, `*.pem`, `*.key`, `auth.json`, `id_rsa*`) and by content (private-key blocks, `sk-`, `ghp_`, `xox`, `AKIA`, bearer tokens). The summary counts those skips and does not print the contents or the matched text.
4. Write `target_root/<bot>/<relative-path>.md` with gbrain frontmatter. The slug is the path under the source. `origin_relpath` is the path relative to the share (or `external/...` when an input is outside it) and `origin_sha256` is the sha256 of the source bytes.
5. Update `~/.gbrain/bot-loader/state.json` (atomic replace, mode 0600). A matching sha256 is not rewritten and not imported. A source file that disappears is reported as `orphaned <bot> <count>` and the page already written is left in place.

A group whose `source` is `finance` can only use a target directory named `finance`. Targets of different sources cannot contain each other. Bots have no source field of their own, so a finance input cannot be written into `personal`.

## How pages reach gbrain while serve is running

PGLite is single-writer. `com.gbrain.serve` holds `~/.gbrain/brain.pglite`, and a second process that opens that directory fails with `live_serve`. This loader never opens that directory and never passes `--no-delegate`.

Changed pages are imported with:

```bash
gbrain --source <source> put <slug> --file <page> --json
```

`gbrain put` asks the resident owner over the local persistence socket (`maybeDelegateLocalOperation` of `put_page` in `src/cli/main.ts`) before it would connect an engine. The running serve performs the write. A new source is registered the same way, with `gbrain sources add <id> --path <dir> --no-federated --force --json` and no `--url`. `--force` is what registers a plain directory. The finance directory is created only when it has no `.git`. The loader never invokes git and never publishes the checkout.

`gbrain sync` is not used. On a git checkout, sync imports commits unless `--working-tree` is set, and the older serve-delegation ladder refuses `--working-tree`. Sync can also `git pull` when an origin exists. `put` does neither.

`gbrain stats` and `gbrain list` are not on the persistence-socket operation list, so while serve holds the lock they fail instead of opening the database. The loader tries `gbrain stats --by source --json` and `gbrain list` once per run. When that works, the summary's `via=stats` counts are live page totals (bot lines count slugs equal to the bot id or starting with `<bot>/`). When it does not, `via=manifest` counts pages this loader has successfully put, and the summary includes `WARN page counts from loader manifest`.

The admin token at `~/.gbrain/serve/admin-token` is the owner bootstrap credential for `/admin` and `gbrain mcp admin`. It is not an MCP bearer, and this loader does not read it.

## Personal source and git

`scripts/grok-shared-brain/step4-sources.sh` runs `git init` in the personal source directory and commits a README with a repo-local identity. It does not add a remote and it does not publish the checkout. Whether an origin was added later is local state and is not in this repo. The loader never commits and never pushes, so bot pages it writes stay uncommitted working-tree files. A later `gbrain sync` without `--working-tree` will not import those uncommitted files; the loader's own `gbrain put` is what indexes them. Do not point a checkout publisher at the bot folders.

The finance source is a plain directory (`sources add --force`, no remote, no push). If `.git` appears there, that group is skipped and the run exits non-zero.

## Config schema

`docs/grok/bot-loader/config.example.json` is the shape. `<share>` is replaced with `share_root`. `~` is the home directory.

| Field | Meaning |
| --- | --- |
| `share_root` | Mount that must be a real filesystem mount. The example is `~/mnt/netfs`. |
| `state_path` | Manifest. Default `~/.gbrain/bot-loader/state.json`. |
| `summary_path` | Last summary. Default `~/.gbrain/bot-loader/last-summary.txt`. |
| `lock_path` | Overlap lock. Default `~/.gbrain/bot-loader/run.lock`. |
| `host_env` | File with `GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>`. Default `~/.gbrain/serve/host.env`. |
| `gbrain_bin` | Binary used for `put`, `sources add`, `stats`, and `list`. Default `gbrain`. |
| `max_bytes` | Per-file cap. Default 1048576. |
| `csv_max_rows` | Data rows kept from a CSV. Default 500. |
| `box_export_max_age_hours` | Stamp age before a warning. Default 36. |
| `box_export_dir` | Directory whose `EXPORTED_AT` is checked. Default `<share>/personalgrok/gbrain/_box-export`. |
| `groups[].source` | gbrain source id. The only destination for that group's bots. |
| `groups[].target_root` | Directory registered as that source. Finance must be named `finance`. |
| `groups[].extensions` | Allowlist. Omitted personal groups use `.md .txt .json .yaml .yml`. Omitted finance groups also use `.csv`. |
| `groups[].ensure_source` | Create the source when it is missing. Default true for `finance`. |
| `groups[].forbid_git` | Skip the group when `target_root/.git` exists. Default true for `finance`. |
| `groups[].bots[].id` | Placeholder or real id. Lowercase slug. One subfolder under the target. |
| `groups[].bots[].inputs[]` | `{ "path", "required", "role"? }`. `required` false warns and continues when the folder is missing. `required` true also warns and continues: an unmounted share root is the hard failure. `role` `box-export` marks a box-export folder. Omitted `inputs` means `<share>/personalgrok/<bot>` and `<share>/personalgrok/gbrain/_box-export/<bot>`. An input inside another input of the same bot is covered by the parent walk. |

## Box export helper

`scripts/bot-loader/box-export.py` runs on the Linux host with Python 3.9's standard library. The config path is the only required argument. `--out` defaults to `~/.gbrain/box-export`. `--dry-run` prints counts and writes nothing. Each real run builds a new tree in a temp directory, writes `EXPORTED_AT` (UTC timestamp, then `<bot> <file count>`), and swaps it into place. It copies only `profile.json`, `memory/profile.md`, `memory/log/*.md`, `attachments/*.md`, and `attachments/*.txt`, with the same secret skips, and it does not modify its sources.

```bash
python3 scripts/bot-loader/box-export.py docs/grok/bot-loader/box-export.example.json --dry-run
```

Copying that directory onto the share at `personalgrok/gbrain/_box-export/` is a separate job and is not part of this checkout.

## Nightly agent

`scripts/bot-loader/com.gbrain.bot-loader.plist` is the template. The install block renders `__BUN__`, `__REPO__`, and `__HOME__`, refuses leftover `__` placeholders, runs `plutil -lint`, then `launchctl bootout` and `launchctl bootstrap`. The calendar interval is 03:30 local. Logs are `~/Library/Logs/com.gbrain.bot-loader.log` and `~/Library/Logs/com.gbrain.bot-loader.err`.
