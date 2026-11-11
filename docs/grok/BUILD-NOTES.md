# Build notes: shared brain round 3

Design file (not modified): `docs/grok/gbrain-shared-brain-design-r3.md`

- git commit: `2d5b32068afdea1887f7829f04659e0eef9455d3`
- sha256: `f84e310bb49af8f4449406053cbcff357f74253a993304e577966ac8667444b4`

The runnable kit is `docs/grok/shared-brain/README.md` and `scripts/grok-shared-brain/`. Nothing under `src/` is changed. These scripts do not install Bun, gbrain, or Tailscale, and they do not run `tailscale funnel`.

## Operator decisions

### Q-mlsfs — as designed

Markdown sources and backup copies live on the share: `I:\personalgrok\gbrain\` on Windows, and the Mac mount path `/Volumes/<share>/personalgrok/gbrain`. `<share>` stays a placeholder until the operator runs `ls /Volumes`. The live PGLite index stays on the Mac's local APFS at `~/.gbrain/brain.pglite` (no symlink onto the share). `scripts/grok-shared-brain/step4-sources.sh` creates `personal`, `business`, `hermes`, and `shared` only under `GBRAIN_MLSFS_ROOT`, and it refuses a path that still contains `<` or `>`.

### Q-bots — option (c), Funnel off until the operator turns it on

Standing Grok Bot access is public HTTPS through Tailscale Funnel. The design's default (b) and its "do not enable Funnel" line are replaced by this decision.

The build does not pass `--funnel` to `gbrain mcp expose`, and no script executes `tailscale`. Funnel stays off (`funnel_enabled: false` in every generated token file; `requestFunnelEnable()` returns `ran: false`).

Publish target is the loopback gate on `127.0.0.1:8767`, not gbrain's `127.0.0.1:8766`. Port 8766 is what `gbrain serve` binds. Its `/health` route does not require a bearer, and `/admin` exists. Pointing Funnel at 8766 would publish those routes. The gate refuses that class of request before it proxies.

The operator enables Funnel in person, from the Mac:

```bash
tailscale funnel --bg 8767
```

That is the whole command. It is also printed by `bun scripts/grok-shared-brain/cli-print-funnel.ts`, which exits without running it.

### Q-shared — as designed

Only the host CLI writes `shared` (trusted local IPC to port 8766). Client tokens read `shared` and write only their own source. The gate returns 403 `shared_write_forbidden` for a write whose source is `shared`, including when a caller bypasses the token-file parser and puts `shared` on a write list. `parseFunnelConfig` rejects a token file that grants `shared` as a write source.

## Funnel rules that the design's Serve path does not have

| Rule | Behavior |
| --- | --- |
| No token, or a bearer that matches no hash | 401 on every route, including `/health` and `/admin` |
| Bearer matches a client that lacks the route | 403 `wrong_scope` |
| `/admin`, `/metrics`, `/token`, `/register`, `/revoke`, `/authorize`, `/.well-known` | 403 `admin_forbidden` even with a valid client token. Not proxied |
| Write to `shared`, or a write/read outside the client's sources | 403. Not proxied. A `tools/call` whose name is not in the gate's read or write allowlist is 403 (fail closed) |
| Rate limit | Per client id, default 60 requests per 60 seconds, then 429 |
| Token compare | SHA-256 then `timingSafeEqual` on the digests. Every client hash is checked |
| Token storage | `~/.gbrain/serve/funnel-tokens.json`, mode 0600. Hashes only. Refuses a path inside the git repo |
| Logs | Method, path, client id, status. Bearers are redacted. Query strings are not logged |
| Bind | `127.0.0.1` only. Upstream must be `http://127.0.0.1` or `http://localhost` |

Clients in the token file: `personal`, `business`, `hermes`.

Generate (prints plaintext once on stdout; does not enable Funnel):

```bash
bun scripts/grok-shared-brain/cli-generate-tokens.ts
```

Optional `--out ABSOLUTE_PATH` (default `~/.gbrain/serve/funnel-tokens.json`) and `--force`.

File shape:

```json
{
  "version": 1,
  "funnel_enabled": false,
  "rate_limit": { "window_ms": 60000, "max": 60 },
  "clients": {
    "personal": {
      "token_sha256": "<64 hex chars>",
      "routes": ["health", "mcp"],
      "write": ["personal"],
      "read": ["personal", "shared"]
    }
  }
}
```

`business` writes `business` and reads `business` plus `shared`. `hermes` writes `hermes` and reads `hermes` plus `shared`.

After `gbrain mcp grant` writes a credential JSON, set `upstream_token_file` on that client to the absolute path of the JSON (outside the repo). The gate reads `access_token` from that file when it proxies to `127.0.0.1:8766` and does not write the grant token into the funnel file or the log. Loopback thin CLIs in the design still talk to port 8766 directly and do not use this gate.

Start the gate (still does not run Tailscale). The process listens even when port 8766 is down; a proxied call then returns 502 and the next request tries again:

```bash
bun scripts/grok-shared-brain/cli-gate.ts --tokens "$HOME/.gbrain/serve/funnel-tokens.json" --upstream http://127.0.0.1:8766 --port 8767
```

Login and reboot use the LaunchAgent `com.gbrain.funnel-gate` (`scripts/grok-shared-brain/launchd/com.gbrain.funnel-gate.plist`, `RunAtLoad`, `KeepAlive` with `SuccessfulExit` false, `ThrottleInterval` 15). Copyable install and uninstall steps are in `docs/grok/shared-brain/README.md`. The gate reads `GBRAIN_EXPECTED_HOST` from `~/.gbrain/serve/host.env` and, on a mismatch, logs `Wrong machine:` plus the short hostname and exits 0 so launchd does not restart it. A non-zero exit still restarts. The plist stores no token and no hostname. Nothing in the kit runs `tailscale funnel` or `tailscale serve`.

## QA lows

### L1 — git identity before the Step 4 commit

`step4-sources.sh` commits with repo-local identity flags, not a global `git config`:

```bash
git -C "$dir" -c user.name=gbrain -c user.email=gbrain@localhost commit -m "initial $s"
```

The email is the placeholder `gbrain@localhost`.

### L2 — stale SMB `index.lock`

`cli-clear-index-lock.ts` refuses to delete `.git/index.lock` unless `--force` is passed (exit 2, lock left in place). A git on the Windows side of the share is not in this machine's process list, so the default is to leave the lock. With `--force`, deletion still requires every local check: the process list was readable, no process command is `git`, `git.exe`, or `git-*`, `.git` is a real directory, the lock is a regular file, and the lock is at least 10 minutes old and not dated in the future. The process list is checked again immediately before unlink. Step 4 calls the clearer without `--force`.

### Hostname file

`setup.sh` does not contain a hostname. It reads `GBRAIN_EXPECTED_HOST` from `~/.gbrain/serve/host.env` (mode of that directory stays outside the repo, so it is not a gitignore path). One line, placeholder `<MAC_HOSTNAME>`. A missing file or a missing variable refuses to run.

## Runtime the operator installs in person

No Homebrew. This build does not install anything on the Mac.

| Tool | Version | How |
| --- | --- | --- |
| Xcode Command Line Tools | the version `xcode-select --install` supplies (git + clang) | `xcode-select --install`, then `git --version` |
| Bun | **1.4.4 or newer** (`package.json` `engines.bun`, `MINIMUM_BUN_VERSION`) | Official installer only: `curl -fsSL https://bun.sh/install \| bash`, then `export PATH="$HOME/.bun/bin:$PATH"`. If Gatekeeper quarantines it: `xattr -d com.apple.quarantine "$HOME/.bun/bin/bun"`. Confirm with `bun --version`. |
| gbrain CLI | upstream `stable` | `bun install -g github:garrytan/gbrain#stable` |
| Tailscale | already on the Mac | Do not install it. Do not run Funnel until the command above. |

Node and Python are not required. Postgres and an embedding key are not part of this layout (PGLite, `--no-embedding`).

## Deviations from the design text

- Section 8 said no PR and no code. The operator asked for this build and a PR into `grok`. `master` and `hermes` are not targets.
- Q-bots (c) replaces default (b) for the standing Bot connector. Tailnet Serve from `gbrain mcp expose --port 8766 --no-install --yes` (no `--funnel`) can still be what the design's Windows thin CLI uses. The public Bot URL must be the gate on port 8767, or unauthenticated `/health` and `/admin` on port 8766 become public.
- Design section 7.2 curls `/health` with no bearer. That remains true for loopback and for tailnet Serve to port 8766. Funnel traffic to port 8767 cannot do that.
- The gate is new code beside gbrain. It does not change serve's own routes.
