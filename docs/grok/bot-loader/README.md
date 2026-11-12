# Bot knowledge loader

**Say to your agent:** *"Install the nightly bot-knowledge loader from this checkout, keep the real bot list in the local config, and do not push those pages to a git remote."*

The loader reads text from folders you list in a local config, writes one markdown page per file onto the share, and imports the pages that changed. The repo ships placeholders only (`bot-a`, `bot-b`, `fin-bot`). The real bot list, share path, and any extra folders live in `~/.gbrain/bot-loader/config.json`, which is never committed. The list can be any length. Nothing in the loader assumes a fixed number of bots.

Hosted GBrain is at [gbrain.io](https://gbrain.io/cli?ref=agents-md). This loader is the self-hosted path for a brain that already runs on the machine.

## Install or upgrade

Upgrade is this same block after `git pull` on this branch. It runs in a subshell. The first check is the hostname guard. It copies the example config only when `~/.gbrain/bot-loader/config.json` is missing, and it never replaces an existing config with the example. It resolves `gbrain` with `command -v gbrain`, otherwise `~/.bun/bin/gbrain`, writes that absolute path into `gbrain_bin`, and stops if neither exists. When the config still contains `bot-a`, `bot-b`, `fin-bot`, `__SET_ME__`, or an unconfirmed example share root (`~/mnt/netfs`, including a path whose realpath is that directory), the block skips the immediate run and prints `edit <config path>, then rerun this block`.

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
)
```

## Verify

```bash
bash "$HOME/personalgrok/gbrain/scripts/bot-loader/verify.sh"
```

That runs the hostname guard first, then prints `PASS` or `FAIL` for the launchd job, a successful status file newer than 36 hours, an empty `git -C <finance> remote` (or no `.git`), and stuck pendings. `FAIL stuck pending` means the status file contains `WARN stuck pending`. It prints the count lines and exits non-zero if any check failed. A host mismatch leaves `bot-loader: skipped: wrong host` in the status file, so the status check fails.

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

1. Read the bot's input folders. Missing optional folders, a missing `_box-export` directory, and a stale or missing `EXPORTED_AT` stamp (older than `box_export_max_age_hours`, default 36) are warnings. The run still reads the other folders and exits 0. The only hard stop before any write is a share root that is missing or not a real mount (its device id matches its parent). A hostname mismatch logs, writes `bot-loader: skipped: wrong host` plus a `WARN` line into the status file (`summary_path`), and exits 0. Example placeholders (`bot-a`, `bot-b`, `fin-bot`, `__SET_ME__`) and a non-absolute `gbrain_bin` refuse the run with a non-zero exit. A second overlapping run exits non-zero on the lock file. A lock whose pid is dead is taken over.
2. Keep `.md`, `.txt`, `.json`, and the group's extension list, under `max_bytes` (default 1 MiB). `.csv` is on the finance group's default list and becomes a markdown table. Data rows stop at `csv_max_rows` (default 500) with a truncation note. Images, audio, video, archives, and database files (`.db`, `.sqlite`, `-wal`, `-shm`) are skipped even if a group lists them. Directories named `audit`, `audits`, `audit-logs`, or `automations` are not entered. Sources are not modified, moved, or deleted.
3. Skip a whole file when its name or its contents match `scripts/bot-loader/secret-patterns.json` (the same list the box-export helper loads). Names include `config.env`, `*.env`, `.envrc`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, `*.p12`, `*.pfx`, `*-key.json`, `service-account*.json`, `credentials*.json`, `.netrc`, `.npmrc`, and `.pypirc`, plus the older `.env*`, `*token*`, `*secret*`, `*credential*`, `*.pem`, `*.key`, `auth.json`, and `id_rsa*` names. Contents include `sk-ant-`, `sk-proj-`, `github_pat_`, `gh[opsu]_`, `glpat-`, `xox[a-z]-` (including `xoxb`, `xoxp`, `xoxs`, `xoxa`, `xoxe`, and `xoxr`), AWS secret keys, JWTs, every PEM private key, Slack and Discord webhook URLs, and `aws_secret_access_key` or `password=` lines. A match is omitted. It is not redacted into a page. The summary counts those skips and does not print the contents.
4. Write `target_root/<bot>/<relative-path>.md` with gbrain frontmatter. The slug is the path under the source. `origin_relpath` is the path relative to the share (or `external/...` when an input is outside it) and `origin_sha256` is the sha256 of the source bytes.
5. Update `~/.gbrain/bot-loader/state.json` (atomic replace, mode 0600). A matching sha256 that is already in the brain is not rewritten and not imported. A put that exits 10 is pending: the run stays successful, the page is not counted, and the next run retries it. The manifest counts those attempts. After 3 attempts the summary warns `WARN stuck pending <count>`, and verify fails that check. Retries continue. Any other non-zero put is a failure and is not counted. A manifest entry whose source file is gone, or whose bot is no longer in the config, is reported as `orphaned <bot> <count>`, left on disk, and excluded from the counts.

A group with `fail_closed` true is checked as a whole before any page is written. Personal and finance omit the flag and keep the warn-and-continue path above, including a stale top-level `EXPORTED_AT` (`WARN box-export stale`). A fail-closed group that fails a check writes nothing for that group, adds one `SKIP <source>: ...` line, and leaves `bot-loader: ok` unchanged. Other groups still run. Empty `bots` skips with `no bots named` and does not register the source. The summary lines are `no bots named`, `input missing`, `box-export stale` (business), `feed stale` (hermes), `unsigned`, `hash mismatch`, `oversized`, `empty after allowlist`, `denied path in manifest`, `secret-bearing`, `finance-data`, `wrong source`, `partial copy`, `source not created`, and `route`.

A group whose `source` is `finance` can only use a target directory named `finance`. Targets of different sources cannot contain each other. Bots have no source field of their own, so a finance input cannot be written into `personal`.

## How pages reach gbrain while serve is running

PGLite is single-writer. `com.gbrain.serve` holds `~/.gbrain/brain.pglite`, and a second process that opens that directory fails with `live_serve`. This loader never opens that directory and never passes `--no-delegate`.

Changed pages are imported with:

```bash
gbrain --source <source> put <slug> --file <page> --json
```

`gbrain put` with `--file` returns from `runSharedOperation` in `src/cli/main.ts` at the `put_page` branch (line 560) into `runPutFile` in `src/cli/commands/append.ts`. `pageWriteCaller` there (lines 85-93) calls `maybeDelegateLocalOperation` for `put_page` before `connect()`. The resident serve performs the write. A new source is registered with `gbrain sources add <id> --path <dir> --no-federated --force --json` and no `--url`. That command is `source_add` through `maybeDelegateLocalAdministration` in `src/commands/sources-lifecycle.ts` (admin IPC) before `getEngine()`, so it does not call `connectEngine` while serve holds the lock. `--force` is what registers a plain directory. The loader calls it only when the manifest has not yet recorded that source. The loader never publishes the checkout.

`gbrain sync` is not used. On a git checkout, sync imports commits unless `--working-tree` is set, and the older serve-delegation ladder refuses `--working-tree`. Sync can also pull when an origin exists. `put` does neither.

`gbrain stats` and `gbrain list` call `connectEngine`. The loader never runs them, including while serve holds the PGLite lock, so it makes no attempt that would open the database. Per-source lines are labeled `via=pages written by the loader (manifest)`. While serve holds the lock the summary also says `WARN live brain totals are unavailable while serve runs`. A failed put is not counted. Exit 10 is pending and is not counted.

The admin token at `~/.gbrain/serve/admin-token` is the owner bootstrap credential for `/admin` and `gbrain mcp admin`. It is not an MCP bearer, and this loader does not read it.

## Personal source and git

`scripts/grok-shared-brain/step4-sources.sh` runs `git init` in the personal source directory and commits a README with a repo-local identity. It does not add a remote and it does not publish the checkout. Whether an origin was added later is local state and is not in this repo. The loader never commits and never pushes, so bot pages it writes stay uncommitted working-tree files. A later `gbrain sync` without `--working-tree` will not import those uncommitted files; the loader's own `gbrain put` is what indexes them. Do not point a checkout publisher at the bot folders.

The finance source is a plain directory (`sources add --force`, no remote). A group with `forbid_git` true is checked, when `.git` exists, with `git -C <target> remote`. Empty output means the directory has no remotes and the group is written. Any remote, or a check that cannot be run, refuses that group with a clear error. A group with `forbid_git` false is not checked. The finance example sets `forbid_git` true, so a remote there does not write its pages into `personal` or into `finance`, and the run exits non-zero.

## Config schema

`docs/grok/bot-loader/config.example.json` is the shape. `<share>` is replaced with `share_root`. `~` is the home directory.

| Field | Meaning |
| --- | --- |
| `share_root` | Mount that must be a real filesystem mount. An unconfirmed example share root (`~/mnt/netfs`, including a path whose realpath is that directory) refuses the run unless `share_root_confirmed` is true. |
| `state_path` | Manifest. Default `~/.gbrain/bot-loader/state.json`. |
| `summary_path` | Last summary. Default `~/.gbrain/bot-loader/last-summary.txt`. |
| `lock_path` | Overlap lock. Default `~/.gbrain/bot-loader/run.lock`. |
| `host_env` | File with `GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>`. Default `~/.gbrain/serve/host.env`. |
| `share_root_confirmed` | Set true only after the share root is the real mount. Without it, the example share root is a placeholder. |
| `gbrain_bin` | Absolute path used for `put` and `sources add`. The loader refuses a relative value. Install writes the resolved path. The example value `gbrain` is not absolute. |
| `max_bytes` | Per-file cap. Default 1048576. |
| `csv_max_rows` | Data rows kept from a CSV. Default 500. |
| `box_export_max_age_hours` | Stamp age before a warning. Default 36. |
| `box_export_dir` | Directory whose `EXPORTED_AT` is checked. Default `<share>/personalgrok/gbrain/_box-export`. |
| `groups[].source` | gbrain source id. The only destination for that group's bots. |
| `groups[].target_root` | Directory registered as that source. Finance must be named `finance`. |
| `groups[].extensions` | Allowlist. Omitted personal groups use `.md .txt .json .yaml .yml`. Omitted finance groups also use `.csv`. |
| `groups[].ensure_source` | Create the source when it is missing. Default true for `finance`. |
| `groups[].forbid_git` | When true, run the remote check above. Default true for `finance`. When false, git metadata is not a reason to skip the group. |
| `groups[].bots[].id` | Placeholder or real id. Lowercase slug. One subfolder under the target. |
| `groups[].bots[].inputs[]` | `{ "path", "required", "role"? }`. `required` false warns and continues when the folder is missing. `required` true also warns and continues: an unmounted share root is the hard failure. `role` is `box-export` or `local-feed`. Omitted `inputs` on a warn-and-continue bot means `<share>/personalgrok/<bot>` and `<share>/personalgrok/gbrain/_box-export/<bot>`. A fail-closed bot must list a non-empty `inputs` array, and every path must sit inside that group's `stamp_root`. An input inside another input of the same bot is covered by the parent walk. |
| `groups[].fail_closed` | Default false. True runs the whole-group checks. Only `business` (account `businessgrok`) and `hermes` (account `hermes`) are accepted. |
| `groups[].account` | Required when `fail_closed` is true. Compared to `MANIFEST.json`. Not written into page frontmatter. |
| `groups[].stamp_root` | Required when `fail_closed` is true. The only directory those checks read. It must not be the top-level personal `box_export_dir`. A basename `_box-export.in` or ending in `.bak` is a partial copy and is not read. |
| `groups[].box_export_dir` | Optional per group. Business requires it and it must be the same directory as `stamp_root`. Hermes must omit it. |

## Box export helper

`scripts/bot-loader/box-export.py` runs on the Linux host with Python 3.9's standard library. The config path is the only required argument. `--out` defaults to `~/.gbrain/box-export`. `--dry-run` prints counts and writes nothing. Each real run builds a new tree in a temp directory, writes `EXPORTED_AT` (UTC timestamp, then `<bot> <file count>`), and swaps it into place. It copies only `profile.json`, `memory/profile.md`, `memory/log/*.md`, `attachments/*.md`, and `attachments/*.txt`, with the same secret skips, and it does not modify its sources. With no `--account` and no `--source`, the tree has no `MANIFEST.json`. Passing both writes `MANIFEST.json` (`version` 1, `account`, `source`, `exported_at`, `files`, `file_count`, `byte_count`) whose digests are the sha256 of the copied bytes. Passing only one of the two flags is an error and writes nothing.

```bash
python3 scripts/bot-loader/box-export.py docs/grok/bot-loader/box-export.example.json --dry-run
```

Copying that directory onto the share at `personalgrok/gbrain/_box-export/` is a separate job and is not part of this checkout.

## Nightly agent

`scripts/bot-loader/com.gbrain.bot-loader.plist` is the template. The install block renders `__BUN__`, `__REPO__`, `__HOME__`, and `__PATH__` (`~/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin` with the home directory expanded), sets `WorkingDirectory` to the repo, refuses leftover `__` placeholders, runs `plutil -lint`, then `launchctl bootout` and `launchctl bootstrap`. The calendar interval is 03:30 local. Logs are `~/Library/Logs/com.gbrain.bot-loader.log` and `~/Library/Logs/com.gbrain.bot-loader.err`.
