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
# Create ~/.gbrain/serve/host.env first, one untracked line: GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>
GBRAIN_SHARED_APPLY_STEP4=1 bash scripts/grok-shared-brain/setup.sh
```

`setup.sh` reads the expected hostname from an untracked file outside the repo, `~/.gbrain/serve/host.env`. It refuses to run when that file or `GBRAIN_EXPECTED_HOST` is missing. The file is one assignment and is not committed:

```
GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>
```

`<MAC_HOSTNAME>` is the placeholder. Replace it locally with the output of `hostname -s`. Do not commit that file.

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

Missing or unknown bearers are 401, including `/health`. A token for the wrong route or source is 403. `/admin` and a write to `shared` are 403 with a valid token. Over the per-token limit the response is 429.

Expose gbrain without Funnel (design step 5). Do not add `--funnel`:

```bash
gbrain mcp expose --port 8766 --no-install --yes
```

## Turn Funnel on (operator only)

Funnel is public HTTPS. The scripts never run this. On the Mac, in person:

```bash
tailscale funnel --bg 8767
```

That publishes the gate, not port 8766. The Bot MCP URL is `https://<MAC_MAGICDNS>/mcp` with that client's bearer. `<MAC_MAGICDNS>` and `<WINDOWS_TAILNET_HOST>` stay placeholders.
