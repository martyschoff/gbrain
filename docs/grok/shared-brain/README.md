# Shared brain on the Mac

**Say to your agent:** *"Stand up one gbrain on the Mac mini, with separate memory for personalgrok, businessgrok and Hermes, markdown on the share, the index on the Mac disk, and a Funnel MCP connector that stays off until I turn it on."*

The design is `docs/grok/gbrain-shared-brain-design-r3.md` (do not edit it). Decisions, the token file, and deviations are in `docs/grok/BUILD-NOTES.md`. Scripts live in `scripts/grok-shared-brain/`. They do not install software and they do not run `tailscale funnel`.

## Runtime to install in person

The Mac has no Homebrew path in this setup. Install these yourself:

1. **Xcode Command Line Tools** (git): `xcode-select --install`, then `git --version`.
2. **Bun 1.4.4 or newer**, from the official installer only:

   ```bash
   curl -fsSL https://bun.sh/install | bash
   export PATH="$HOME/.bun/bin:$PATH"
   bun --version
   ```

   If Gatekeeper quarantines the binary: `xattr -d com.apple.quarantine "$HOME/.bun/bin/bun"`.
3. **gbrain CLI** from upstream stable: `bun install -g github:garrytan/gbrain#stable`.

Tailscale is already on the Mac. Do not install it again. Node, Python, Postgres, and an embedding key are not required (PGLite, `gbrain init --pglite --no-embedding`).

## Layout

| What | Where |
| --- | --- |
| Markdown sources and backup copies | `/Volumes/<share>/personalgrok/gbrain/` (`I:\personalgrok\gbrain\` on Windows). `<share>` stays a placeholder. |
| Live PGLite index | `~/.gbrain/brain.pglite` on local APFS |
| gbrain HTTP | `127.0.0.1:8766` |
| Funnel gate | `127.0.0.1:8767` (bearer required on every route) |
| Funnel token hashes | `~/.gbrain/serve/funnel-tokens.json` mode 0600, outside the repo |

Sources: `personal`, `business`, `hermes` (`--no-federated`) and `shared` (`--federated`, host writes only).

```bash
export GBRAIN_MLSFS_ROOT="/Volumes/<share>/personalgrok/gbrain"   # replace <share> locally; do not commit the real name
# setup.sh reads GBRAIN_EXPECTED_HOST from ~/.gbrain/serve/host.env. It does not write that file.
GBRAIN_SHARED_APPLY_STEP4=1 bash scripts/grok-shared-brain/setup.sh
```

`setup.sh` does not create `~/.gbrain/serve/host.env`. It reads `GBRAIN_EXPECTED_HOST` from that file (the same name `host-guard.ts` reads) and refuses to run when the file or the variable is missing. The file is one assignment, already present on the Mac, and is not committed:

```
GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>
```

`<MAC_HOSTNAME>` is the placeholder for the short hostname (`hostname -s`). Do not commit that file.

Step 4 sets `user.name=gbrain` and `user.email=gbrain@localhost` only on the commit command. It does not remove a stale `.git/index.lock` unless you re-run the clearer with `--force`. It does not run `gbrain sources add` (that needs the brain the operator inits in design step 3). After init, from the Mac:

```bash
ROOT="$GBRAIN_MLSFS_ROOT"
gbrain sources add personal --path "$ROOT/personal" --name "personalgrok" --no-federated --json
gbrain sources add business --path "$ROOT/business" --name "businessgrok" --no-federated --json
gbrain sources add hermes --path "$ROOT/hermes" --name "hermes" --no-federated --json
gbrain sources add shared --path "$ROOT/shared" --name "shared" --federated --json
```

A stale `.git/index.lock` is left in place unless `--force` is passed. Even then it is removed only when `ps` shows no git process, the lock is a regular file at least 10 minutes old, and that is checked again immediately before unlink:

```bash
bun scripts/grok-shared-brain/cli-clear-index-lock.ts "$GBRAIN_MLSFS_ROOT/personal" --force
```

## Tokens

```bash
bun scripts/grok-shared-brain/cli-generate-tokens.ts
```

Stdout prints the three plaintext bearers once (`personal`, `business`, `hermes`). The file stores SHA-256 hashes, `funnel_enabled: false`, and per-client read/write sources. Compare is constant-time. Logs must not contain the bearers. Put each bearer only in that Bot's connector. Optional `upstream_token_file` (absolute path, outside the repo) points at the gbrain grant JSON whose `access_token` the gate forwards to port 8766.

```bash
bun scripts/grok-shared-brain/cli-gate.ts \
  --tokens "$HOME/.gbrain/serve/funnel-tokens.json" \
  --upstream http://127.0.0.1:8766 \
  --port 8767
```

Missing or unknown bearers are 401, including `/health`. A token for the wrong route or source is 403. `/admin` and a write to `shared` are 403 with a valid token. Over the per-token limit the response is 429. The process listens even when nothing is on port 8766. A proxied call then returns 502, and the next request tries the upstream again.

The allowlist covers what an MCP call needs: `Content-Type`, `Accept`, `Accept-Encoding`, `User-Agent`, `Mcp-Session-Id`, `Mcp-Protocol-Version`, and `Last-Event-ID`. The gate sets `Authorization` from the grant file and `Content-Length` from the body it read. `X-Gbrain-Client`, `X-Gbrain-On-Behalf-Of`, `X-Gbrain-Agent-Label`, `x-qm-actor`, and `x-qm-audience` are dropped on purpose for Funnel grants, so a remote client cannot set its client identity, on-behalf-of, label, or audience. The gate does not send `X-Forwarded-Proto`. Funnel terminates HTTPS, and the gate only sees HTTP on loopback, so it cannot honestly set that header. Any request `Content-Encoding` other than `identity` gets 415 `unsupported_content_encoding`. The gate does not decompress, so a gzip or mixed coding would be forwarded as raw bytes and misread; the body is not read and not forwarded.

Expose gbrain without Funnel (design step 5). Do not add `--funnel`:

```bash
gbrain mcp expose --port 8766 --no-install --yes
```

## LaunchAgent

`com.gbrain.funnel-gate` starts the gate at login and after a reboot. `RunAtLoad` is true. `KeepAlive` is `{ SuccessfulExit: false }` with `ThrottleInterval` 15, so a non-zero exit restarts and an exit 0 stays down. The plist template is `scripts/grok-shared-brain/launchd/com.gbrain.funnel-gate.plist`. Placeholders are `__BUN__`, `__REPO__`, and `__HOME__`. The installed plist has absolute paths because launchd has no `PATH`.

The gate reads `GBRAIN_EXPECTED_HOST` from `~/.gbrain/serve/host.env`, the same variable `setup.sh` reads. On a mismatch it logs `Wrong machine:` plus the short hostname and exits 0, so launchd does not restart it. No hostname is written into the plist or this repo. The agent does not run `tailscale funnel` or `tailscale serve`. Leave Funnel off until the step in [Turn Funnel on](#turn-funnel-on-operator-only).

Each block is one paste into an interactive Terminal. The body is a subshell, so `exit` and `set -euo pipefail` end only that subshell. The guard is the first thing inside it. `~/.gbrain/serve/host.env` is already on the Mac. Do not `cat` a grant file or the admin token.

`gbrain mcp expose` writes the owner credential to `$HOME/.gbrain/serve/admin-token` (`adminTokenPath` in `src/core/serve-service.ts`, under `~/.gbrain/serve`). `setup.sh` does not. The grant steps pass that path and only check that the file exists.

The harness id is `grok-bot` for all three. That is the HTTP thin-cli id in `gbrain mcp` (`src/core/harness/registry.ts`). The client name and `--source` are `personal`, `business`, or `hermes`. `--profile memory-writer` is the default writer profile. Do not use `operator` or `full`. The grant URL is loopback serve, because the gate forwards that file's `access_token` to `127.0.0.1:8766`. The public bots keep using their Funnel bearers, not these files.

A successful `gbrain mcp grant --json` prints a redacted receipt (`credentialReceipt`: client id, URL, profile, harness, source, expiry). A failure prints the error message on stdout, and that text is scrubbed only for the admin bootstrap token, so a client secret in an error string could show up. These blocks send stdout to `/dev/null` and print one line that names the private file.

`grok-bot` access tokens expire. The gate reads `access_token` from the grant file on every proxied request and does not refresh it. After you replace a grant file, the next request uses the new value. The checkout these blocks use is `$HOME/personalgrok/gbrain`.

### 1. Grant personal

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
set -euo pipefail
if [ ! -f "$HOME/.gbrain/serve/admin-token" ]; then
  echo "admin token file missing: $HOME/.gbrain/serve/admin-token (gbrain mcp expose writes it; this step does not print it)" >&2
  exit 1
fi
umask 077
mkdir -p "$HOME/.gbrain/serve/grants"
chmod 700 "$HOME/.gbrain/serve/grants"
gbrain mcp grant personal --harness grok-bot --profile memory-writer \
  --source personal --federated-read personal,shared --skills memory-only \
  --url "http://127.0.0.1:8766/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/grants/personal.json" \
  --json >/dev/null
echo "granted personal; private handoff is $HOME/.gbrain/serve/grants/personal.json"
chmod 600 "$HOME/.gbrain/serve/grants/personal.json"
stat -f '%Lp' "$HOME/.gbrain/serve/grants"
stat -f '%Lp' "$HOME/.gbrain/serve/grants/personal.json"
)
```

The directory mode is `700`. The file mode is `600`. Both paths are outside the repo.

### 2. Grant business

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
set -euo pipefail
if [ ! -f "$HOME/.gbrain/serve/admin-token" ]; then
  echo "admin token file missing: $HOME/.gbrain/serve/admin-token (gbrain mcp expose writes it; this step does not print it)" >&2
  exit 1
fi
umask 077
mkdir -p "$HOME/.gbrain/serve/grants"
chmod 700 "$HOME/.gbrain/serve/grants"
gbrain mcp grant business --harness grok-bot --profile memory-writer \
  --source business --federated-read business,shared --skills memory-only \
  --url "http://127.0.0.1:8766/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/grants/business.json" \
  --json >/dev/null
echo "granted business; private handoff is $HOME/.gbrain/serve/grants/business.json"
chmod 600 "$HOME/.gbrain/serve/grants/business.json"
stat -f '%Lp' "$HOME/.gbrain/serve/grants/business.json"
)
```

### 3. Grant hermes

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
set -euo pipefail
if [ ! -f "$HOME/.gbrain/serve/admin-token" ]; then
  echo "admin token file missing: $HOME/.gbrain/serve/admin-token (gbrain mcp expose writes it; this step does not print it)" >&2
  exit 1
fi
umask 077
mkdir -p "$HOME/.gbrain/serve/grants"
chmod 700 "$HOME/.gbrain/serve/grants"
gbrain mcp grant hermes --harness grok-bot --profile memory-writer \
  --source hermes --federated-read hermes,shared --skills memory-only \
  --url "http://127.0.0.1:8766/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/grants/hermes.json" \
  --json >/dev/null
echo "granted hermes; private handoff is $HOME/.gbrain/serve/grants/hermes.json"
chmod 600 "$HOME/.gbrain/serve/grants/hermes.json"
stat -f '%Lp' "$HOME/.gbrain/serve/grants/hermes.json"
)
```

### 4. Point the token file at the grants

This `cd`s to the checkout, parses `funnel-tokens.json` as JSON, sets `upstream_token_file` for `personal`, `business`, and `hermes` to the absolute grant paths, and writes the file back mode `0600`. It does not read or print the grant files. Expected file mode is `600`.

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
set -euo pipefail
REPO="$HOME/personalgrok/gbrain"
if [ ! -f "$REPO/scripts/grok-shared-brain/cli-gate.ts" ]; then
  echo "checkout not found: $REPO/scripts/grok-shared-brain/cli-gate.ts" >&2
  exit 1
fi
cd "$REPO"
bun scripts/grok-shared-brain/cli-set-upstream-tokens.ts \
  --tokens "$HOME/.gbrain/serve/funnel-tokens.json" \
  --grants "$HOME/.gbrain/serve/grants"
stat -f '%Lp' "$HOME/.gbrain/serve/funnel-tokens.json"
)
```

### 5. Install the plist

`REPO` defaults to `$HOME/personalgrok/gbrain`. `sed -i ''` is the macOS form. The bun path, the repo path, and `$HOME` must not contain `#`, `&`, or `\`.

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
set -euo pipefail
REPO="$HOME/personalgrok/gbrain"
if [ ! -f "$REPO/scripts/grok-shared-brain/cli-gate.ts" ]; then
  echo "checkout not found: $REPO/scripts/grok-shared-brain/cli-gate.ts" >&2
  exit 1
fi
BUN="$(command -v bun || true)"
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
fi
case "$BUN" in
  /*) ;;
  *) echo "bun path must be absolute" >&2; exit 1 ;;
esac
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$REPO/scripts/grok-shared-brain/launchd/com.gbrain.funnel-gate.plist" "$HOME/Library/LaunchAgents/com.gbrain.funnel-gate.plist"
sed -i '' \
  -e "s#__BUN__#${BUN}#g" \
  -e "s#__REPO__#${REPO}#g" \
  -e "s#__HOME__#${HOME}#g" \
  "$HOME/Library/LaunchAgents/com.gbrain.funnel-gate.plist"
if grep -n -E '__BUN__|__REPO__|__HOME__' "$HOME/Library/LaunchAgents/com.gbrain.funnel-gate.plist"; then
  echo "FAIL: leftover placeholders" >&2
  exit 1
fi
chmod 644 "$HOME/Library/LaunchAgents/com.gbrain.funnel-gate.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.gbrain.funnel-gate.plist"
)
```

`plutil` prints `OK`. Any leftover placeholder prints `FAIL: leftover placeholders`.

### 6. Bootstrap

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
launchctl bootout gui/$(id -u)/com.gbrain.funnel-gate || true
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.gbrain.funnel-gate.plist"
)
```

### 7. Verify

`401` means the gate is listening. Every route needs a bearer, including `/health`, so this curl does not send one and does not need serve to be up. `000` means nothing is listening on `8767`.

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
launchctl print gui/$(id -u)/com.gbrain.funnel-gate | grep -E 'state|pid'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8767/health
tail -n 40 "$HOME/Library/Logs/com.gbrain.funnel-gate.err"
)
```

Expect `401` from curl. The log lines are method, path, client id, and status. They do not contain bearer tokens, grant credentials, or the Authorization header.

### 8. After a reboot

Restart the Mac, log in, and paste this again. Expect the same `401` and a running pid.

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
launchctl print gui/$(id -u)/com.gbrain.funnel-gate | grep -E 'state|pid'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8767/health
tail -n 40 "$HOME/Library/Logs/com.gbrain.funnel-gate.err"
)
```

### 9. Uninstall

This stops the agent and removes the plist. The grant files stay.

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
launchctl bootout gui/$(id -u)/com.gbrain.funnel-gate || true
rm -f "$HOME/Library/LaunchAgents/com.gbrain.funnel-gate.plist"
)
```

To remove the grant files later, paste this. Deleting them does not revoke the clients. `gbrain mcp admin --help` lists `revoke`.

```bash
(
. ~/.gbrain/serve/host.env || exit 1
host=$(hostname -s)
if [ "$host" != "$GBRAIN_EXPECTED_HOST" ]; then
  echo "Wrong machine: $host" >&2
  exit 1
fi
rm -f "$HOME/.gbrain/serve/grants/personal.json" \
  "$HOME/.gbrain/serve/grants/business.json" \
  "$HOME/.gbrain/serve/grants/hermes.json"
)
```

The gate reads `~/.gbrain` and the checkout. It does not read the SMB share, so it does not need Full Disk Access. If the checkout itself is on a network volume, grant Network Volumes access to the bun binary that the plist runs.

## Turn Funnel on (operator only)

Funnel is public HTTPS. The scripts never run this. On the Mac, in person:

```bash
tailscale funnel --bg 8767
```

That publishes the gate, not port 8766. The Bot MCP URL is `https://<MAC_MAGICDNS>/mcp` with that client's bearer. `<MAC_MAGICDNS>` and `<WINDOWS_TAILNET_HOST>` stay placeholders.
