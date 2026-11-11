# DRAFT, NOT YET REVIEWED / NOT YET INSTALLED

# Shared gbrain knowledge store: two Grok Bot accounts + Hermes (round 2)

**Say to your agent:** *"Stand up one gbrain on the Mac mini, Tailscale-only, with separate memory for personalgrok, businessgrok and Hermes, markdown on mlsfs, and the index on the Mac disk."*

Today: Wednesday 11 Nov 2026. Design only. Martin installs in person; this file does not install anything. Round 1 stays at `docs/grok/gbrain-shared-brain-design.md`. This round-2 file replaces r1 as the document a coder should follow. Code citations are from `64de25c0574a825afaa2cd1ada05e95cb0a0f143`.

Martin's request (authoritative, verbatim): *"Using designer using a cloud model ask how to use this GrokBot knowledge from two accounts and Hermes and put this in the grok section. Data on mlsfs and run from the Mac. Only available through tsilscale"* (tsilscale = Tailscale).

---

## 1. Summary and recommendation

**One host brain on the Mac mini, published tailnet-only.** `gbrain mcp expose --port 8766 --no-install --yes` (no `--funnel`, no `--bind`). The process listens on **127.0.0.1:8766** because that is serve's default (`src/commands/serve-http.ts`); expose does not pass `--bind` (`src/core/serve-service.ts` `serveCommandArgv`). Tailscale Serve (not Funnel) puts HTTPS on `https://<MAC_MAGICDNS>/mcp`. Never `0.0.0.0`, never the LAN, never a wildcard.

**Knowledge split.** Three write sources (`personal`, `business`, `hermes`) plus `shared`. Each client token is `memory-writer` on **its own source only**. `--federated-read <own>,shared` is **read** authority (`src/core/ops/context.ts` `assertSourceInCallerWriteScope`; `src/core/persistence/memory-mutations.ts` `grantedWriteSource`). Clients **cannot write** `shared`. **Default: only the Mac host CLI writes `shared`.** Open question Q-shared, that default.

**Grok Bot access is Martin's decision (§4.1).** Default **(b)**: a separate Windows user or machine per Grok account, so the two credential files are not both readable by one Windows login. (a)(b)(c) all still need a **per-call shell approval**, except **(c) Funnel**, which is public HTTPS and needs Martin's explicit OK. This design does not enable Funnel.

**mlsfs (Martin: "Data on mlsfs").** **DEVIATION Martin must approve:** markdown/source checkouts live on `I:\personalgrok\gbrain\` (Mac mount `/Volumes/<share>/personalgrok/gbrain`). Live PGLite stays on Mac APFS (`~/.gbrain/brain.pglite`) as the derived index. Backups go to mlsfs. The live database is **not** on the share. Facts without pages, OAuth clients, tokens, grants, revisions, receipts and the belief ledger **do not rebuild from markdown**.

| Client | Write source | Read sources | How it talks to the brain |
| --- | --- | --- | --- |
| Hermes | `hermes` | `hermes`, `shared` | Thin CLI on the Mac against `http://127.0.0.1:8766/mcp` (this repo has **no** Hermes HTTP adapter; §4.3). |
| personalgrok | `personal` | `personal`, `shared` | Decision (b): that account's Windows user/machine → thin CLI → `https://<MAC_MAGICDNS>/mcp`. Isolation tests also use a loopback grant on the Mac. |
| businessgrok | `business` | `business`, `shared` | Same, **other** Windows user/machine and credential. |
| Mac host CLI | any, including `shared` | all (trusted `remote: false`) | Owner IPC into the live serve (`src/cli/main.ts`). Not a client grant. |

---

## 2. What upstream gbrain is and needs

Verified at `64de25c0`. Nothing below is an invented feature.

### 2.1 Product

GBrain indexes Markdown+YAML pages into PGLite (default) or Postgres+pgvector (`docs/ENGINES.md`, `docs/guides/where-your-memory-lives.md`). CLI and MCP come from `src/core/operations.ts`. **Not SQLite.**

Two axes (`docs/architecture/brains-and-sources.md`): **brain** = which database; **source** = which repo inside it. Remote grants: one **write** source (`--source`) plus optional **read** sources (`--federated-read`) (`src/commands/mcp.ts`, `src/core/persistence/write-grant.ts`).

### 2.2 Runtime (Martin installs; no Homebrew)

| Need | Required? | Without Homebrew | How |
| --- | --- | --- | --- |
| **Xcode Command Line Tools** (git + clang) | Yes. `bun install -g github:…` needs `git`. | Yes. | `xcode-select --install`. Then `git --version`. |
| **Bun ≥ 1.4.4** | Yes (`package.json` engines, `src/core/runtime-version.ts`). | Yes. Official installer. | `curl -fsSL https://bun.sh/install \| bash`; `export PATH="$HOME/.bun/bin:$PATH"`. If Gatekeeper quarantines the binary: `xattr -d com.apple.quarantine "$HOME/.bun/bin/bun"` then `bun --version`. |
| **gbrain CLI** | Yes. | Yes, once Bun+git exist. | `bun install -g github:garrytan/gbrain#stable`. |
| **Node / Python** | No. | n/a | Skip. System Python 3.9 is unused. |
| **PGLite** | Default engine. | Bundled. | `gbrain init --pglite --no-embedding`. |
| **Postgres + pgvector** | No for v1. | Postgres.app / Docker Desktop `.dmg` / Supabase — not brew. | Skip. |
| **Embedding key** | No for keyword memory. | n/a | Stay `--no-embedding` until Martin opts in. Relay the init search-mode matrix (`INSTALL_FOR_AGENTS.md` Step 3.5). |
| **Tailscale** | Already on the Mac. | Already present. | Do not brew-install it. Pass `--no-install` on expose. Enable MagicDNS + HTTPS certificates. Do **not** enable Funnel. |
| **launchd** | Yes. | Built-in. | Installed by expose as `com.gbrain.serve` (`src/core/serve-service.ts`). |

**Windows side (decision b, each isolated user/machine):** Git for Windows (official installer). Bun via the official Windows script (`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://bun.sh/install.ps1 \| iex"` — Martin runs this; this doc does not). Then `bun install -g github:garrytan/gbrain#stable`. Same Bun floor.

### 2.3 Serve, expose, grants (verified)

- Default HTTP bind is `127.0.0.1` (`src/commands/serve-http.ts`). expose's wrapper argv is `serve --http --port N --public-url URL` plus optional `--surface` / `--advertise` / `--enable-dcr` — **no `--bind`** (`src/core/serve-service.ts` `serveCommandArgv`).
- Real expose command for this host: `gbrain mcp expose --port 8766 --no-install --yes`. That is the full argv. Do not add `--funnel`. Do not add `--bind`.
- Loopback HTTP is the only plaintext URL `assertSecureEndpoint` allows; everything else must be HTTPS (`src/core/harness/credentials.ts`).
- New `memory-writer` grants are **renewable, TTL 3600s** (`src/core/grants/profiles.ts` `RENEWABLE_GRANT_TTL_SECONDS`). `grok-bot` is `renewable: true` (`src/core/harness/registry.ts`). Refresh: `gbrain connect <url> --harness grok-bot --credentials-file FILE --root ROOT --install --fresh-token --yes` when the handoff has a `client_secret`; otherwise mint a new grant (`src/core/harness/install.ts` `inlineTokenReceipt`).
- `gbrain mcp verify` **requires** `--credentials-file` (`src/commands/mcp.ts`).
- `gbrain connect --install` requires `--yes` or a TTY; non-interactive without `--yes` exits 3 (`src/commands/connect.ts`).
- Thin-cli harness ids that write `bin/gbrain` are `grok-bot`, `muse`, `openclaw` (`src/core/harness/registry.ts` `connection: 'thin-cli'`, `src/core/harness/install.ts`). `hermes` is **stdio / manual only**. `generic` is **http / manual** and writes **no** launcher.
- PGLite is single-writer. Local CLI while HTTP serve runs delegates over the owner socket as **trusted local** (`remote: false`) (`src/cli/main.ts`). That path is **not** a client grant — it can write `default` / `shared`. Client tests must use the thin CLI (HTTP, `remote: true`).
- `backup create` holds the writer lock and is not a live-serve delegate. Stop serve, dump, start serve.
- Writes may return `write_pending` (CLI exit 10, `src/core/error-registry.ts`, `src/core/exit-codes.ts`). Poll `gbrain write-request <id> --json`. `--accept-pending` maps pending to exit 0; live accept must wait for commit.

### 2.4 Assumptions (not in this repo)

- Two Grok accounts (personalgrok, businessgrok) with machine-targeted Windows shells that need **approval each time**.
- Hermes is a private agent on the Mac (`<HERMES_PRIVATE_REPO>`). This repo's Hermes integration is stdio (`docs/mcp/HERMES.md`).
- mlsfs = `I:\personalgrok\gbrain\`. Mac volume name `<share>` is unknown until `ls /Volumes`.
- Windows computer names: `<WINDOWS_PERSONAL_HOST>` and `<WINDOWS_BUSINESS_HOST>` (decision b; they may be two users on one box, in which case use two `COMPUTERNAME`/`USERNAME` pairs and keep the files in each user's profile).
- martin-finance-web already uses Tailscale-IP port **8765**. gbrain local port is **8766**.

---

## 3. Architecture

### 3.1 Diagram

```
  Grok Bot personalgrok (vendor cloud, not on tailnet)
  Grok Bot businessgrok (vendor cloud, not on tailnet)
           │  machine-targeted shell, approval each call
           │  (Funnel OFF — no public MCP URL)
           ▼
  Windows user/machine A (personalgrok only)     Windows user/machine B (businessgrok only)
  thin CLI + 0600 personalgrok-tailnet.json      thin CLI + 0600 businessgrok-tailnet.json
           │ HTTPS https://<MAC_MAGICDNS>/mcp
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Mac mini  hostname Martins-Mac-mini                                  │
│                                                                      │
│  Hermes ──► $HOME/gbrain-clients/hermes/bin/gbrain                   │
│             (thin CLI, hermes-loopback.json)                         │
│             http://127.0.0.1:8766/mcp                                │
│                                                                      │
│  launchd com.gbrain.serve                                            │
│    ProgramArguments: ~/.gbrain/serve/gbrain-serve.sh                 │
│    wrapper exec: gbrain serve --http --port 8766 --public-url https://<MAC_MAGICDNS> │
│    listen: 127.0.0.1:8766   (serve default; expose does not pass --bind) │
│    PGLite: ~/.gbrain/brain.pglite     ← APFS, derived index          │
│                                                                      │
│  Tailscale Serve (NOT Funnel): :443 <MAC_MAGICDNS> → 127.0.0.1:8766  │
│                                                                      │
│  Host CLI (trusted) writes `shared` via owner IPC                    │
└──────────┬───────────────────────────────────────────────────────────┘
           │ source checkouts (markdown record)
           ▼
  mlsfs  I:\personalgrok\gbrain\
         /Volumes/<share>/personalgrok/gbrain/
           personal/   business/   hermes/   shared/   backups/
```

### 3.2 Ports and binds

| Listener | Bind | Port | Reachable from |
| --- | --- | --- | --- |
| `gbrain serve --http` | `127.0.0.1` (default; **not passed as `--bind`**) | 8766 | This Mac only |
| Tailscale Serve | MagicDNS `:443` | proxies to 8766 | Tailnet only |
| Funnel | off | — | — |

Literal `--bind <MAC_TS_IP>` is **not** used. Grants to `http://<MAC_TS_IP>:8766/mcp` fail `assertSecureEndpoint`. Loopback + Serve is the shape expose actually installs.

### 3.3 Write / read flow

Remote `remember` / `put_page`: HTTP MCP, `remote: true`, write source = grant `--source` (`grantedWriteSource`). A `source_id` other than that grant is `permission_denied` (`memory-mutations.ts`). `--federated-read` does not confer writes (`assertSourceInCallerWriteScope`).

Host `gbrain remember --source shared` while serve is up: owner IPC, `remote: false`, **not** fenced by a client grant.

---

## 4. Connection path for each client

### 4.1 DECISION — how the Grok Bots get in

Cloud Bots cannot open a tailnet-only MCP URL (`docs/guides/grok-bot.md`, `docs/guides/remote-mcp.md`). Standing MCP-by-URL needs Funnel (public HTTPS). A Windows shell relay is never standing: **every remember/recall needs a new approval** (task fact).

| Option | Standing Bot MCP? | Tailscale-only? | Credential isolation | Per-call shell approval? |
| --- | --- | --- | --- | --- |
| **(a)** No standing Bot access. Occasional relay on a shared Windows login. | No | Yes | **No** — one Windows user can read both 0600 files. Source grants do not protect files on disk. | **Yes** |
| **(b)** Separate Windows **user or machine** per account. Thin CLI + that account's grant only. **Default.** | No | Yes | **Yes** if each profile cannot read the other's `%USERPROFILE%\.gbrain\credentials`. | **Yes** |
| **(c)** Funnel exception: `gbrain mcp expose --port 8766 --no-install --funnel --yes` and add `https://<MAC_MAGICDNS>/mcp` as a Bot MCP connector. | Yes (URL connector) | **No. Public HTTPS.** Needs Martin's explicit OK. | Yes, if each Bot keeps its own grant and does not share `/workspace` (two accounts ⇒ two vendor computers, assumed). | **No** for MCP calls; Funnel is the standing path |

**Default: (b).** It keeps "only through Tailscale." It does **not** give standing Grok Bot access. Say that plainly: **Tailscale-only means no standing Grok Bot MCP today.** (a) is worse isolation. (c) is the only standing option and contradicts Martin's Tailscale-only sentence until he opts in.

Live accept 10b/10c (Bot path) must run from each Bot **without** that session being able to read the other account's credential file.

### 4.2 personalgrok and businessgrok grants

**Loopback grants** (Mac isolation tests, 10a–10d) — `http://` legal only on loopback:

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
umask 077
mkdir -p "$HOME/.gbrain/serve/credentials"
gbrain mcp grant personalgrok-loopback --harness grok-bot --profile memory-writer \
  --source personal --federated-read personal,shared --skills memory-only \
  --url "http://127.0.0.1:8766/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/credentials/personalgrok-loopback.json" \
  --dry-run --json
gbrain mcp grant businessgrok-loopback --harness grok-bot --profile memory-writer \
  --source business --federated-read business,shared --skills memory-only \
  --url "http://127.0.0.1:8766/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/credentials/businessgrok-loopback.json" \
  --dry-run --json
```

Repeat without `--dry-run` after review.

**Tailnet grants** (decision b, Windows) — HTTPS MagicDNS:

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp grant personalgrok-tailnet --harness grok-bot --profile memory-writer \
  --source personal --federated-read personal,shared --skills memory-only \
  --url "https://<MAC_MAGICDNS>/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/credentials/personalgrok-tailnet.json" \
  --dry-run --json
gbrain mcp grant businessgrok-tailnet --harness grok-bot --profile memory-writer \
  --source business --federated-read business,shared --skills memory-only \
  --url "https://<MAC_MAGICDNS>/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/credentials/businessgrok-tailnet.json" \
  --dry-run --json
```

Move `personalgrok-tailnet.json` to the personal Windows profile only; `businessgrok-tailnet.json` to the business profile only. Never both on one user profile (that is option a).

Windows personal host:

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_PERSONAL_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_PERSONAL_HOST>" }; New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gbrain\credentials" | Out-Null }
```

Windows business host: same wrapper with `<WINDOWS_BUSINESS_HOST>`.

Install thin CLI (each side; `--yes` required when non-interactive):

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_PERSONAL_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_PERSONAL_HOST>" }; gbrain connect "https://<MAC_MAGICDNS>/mcp" --harness grok-bot --credentials-file "$env:USERPROFILE\.gbrain\credentials\personalgrok-tailnet.json" --root "$env:USERPROFILE\gbrain-clients\personalgrok" --install --yes }
```

Token refresh (hourly): same command plus `--fresh-token` when the JSON has `client_secret`.

### 4.3 Hermes — honest client path

**There is no Hermes HTTP MCP client in this repo.** `src/core/harness/registry.ts`: `hermes` modes `['stdio']`, connection `manual`. `docs/mcp/HERMES.md` registers `hermes mcp add gbrain --command $(which gbrain) --args serve` — a **second** `gbrain serve` on PGLite hits `live_serve`. `gbrain setup hermes` exists (`docs/mcp/HERMES.md`) and writes `$HERMES_HOME/SOUL.md` plus a stdio hook; it does **not** create an HTTP client. `--harness generic` is HTTP/manual and **does not** write `bin/gbrain`.

**Fallback that the code actually installs:** a thin CLI using harness id `grok-bot` (one of the three `connection: 'thin-cli'` ids) against loopback, `--root` required (`src/core/harness/install.ts`). This is an HTTP client installer, not a claim that Hermes is Grok Bot. Martin's Hermes should **shell out to that launcher**. Do not `hermes mcp add … --args serve` while `com.gbrain.serve` holds PGLite.

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp grant hermes-loopback --harness grok-bot --profile memory-writer \
  --source hermes --federated-read hermes,shared --skills memory-only \
  --url "http://127.0.0.1:8766/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/credentials/hermes-loopback.json" \
  --dry-run --json
# after review, without --dry-run, then:
gbrain connect "http://127.0.0.1:8766/mcp" --harness grok-bot \
  --credentials-file "$HOME/.gbrain/serve/credentials/hermes-loopback.json" \
  --root "$HOME/gbrain-clients/hermes" --install --yes
gbrain mcp verify --client "$(jq -r .client_id "$HOME/.gbrain/serve/credentials/hermes-loopback.json")" \
  --harness grok-bot --url "http://127.0.0.1:8766/mcp" \
  --credentials-file "$HOME/.gbrain/serve/credentials/hermes-loopback.json" --json
```

If Martin's Hermes later grows a native HTTP MCP URL setting, point it at `http://127.0.0.1:8766/mcp` with this grant. Until then, the launcher is the client.

---

## 5. Auth and knowledge separation

### 5.1 Grants (one write source each)

| Grant name | `--source` (write) | `--federated-read` (read) | Profile |
| --- | --- | --- | --- |
| `hermes-loopback` | `hermes` | `hermes,shared` | `memory-writer` |
| `personalgrok-loopback` / `-tailnet` | `personal` | `personal,shared` | `memory-writer` |
| `businessgrok-loopback` / `-tailnet` | `business` | `business,shared` | `memory-writer` |
| Mac host CLI | n/a (trusted) | n/a | writes `shared` |

Do not grant `operator` or `full`. Do not `gbrain auth create` without `--scopes`. Do not `--enable-dcr`. `--skills memory-only`.

**Q-shared (open, default = host-only writes).** A second grant per client with `--source shared` would allow client writes to `shared`; each client would then need two launchers. Default is **no** second grant. 10d proves clients are **refused** on `shared` and can **read** a host-written shared fact.

### 5.2 Source federation (host search vs tokens)

`gbrain sources add --path` stores `federated` only when `--federated` / `--no-federated` is passed (`src/core/sources-ops.ts` path B). GitHub/Google kinds default `federated: true` (same file ~649). Unqualified **host** search mixes sources with `federated: true` (`src/core/sources-load.ts`). **Tokens ignore that flag**; they use `--source` + `--federated-read`.

Create the three private sources with `--no-federated` and `shared` with `--federated`, so an unscoped host query does not mix personal/business/hermes. Client tokens stay scoped regardless.

### 5.3 Credential store and rotation

| Secret | Where | Never |
| --- | --- | --- |
| Admin token | `~/.gbrain/serve/admin-token` (expose, 0600) | plist, wrapper, git, chat, logs |
| Client handoffs | `~/.gbrain/serve/credentials/*.json` on the Mac; each Windows user's own profile | The other account's machine; transcripts |
| Provider keys (later) | `~/.gbrain/env` 0600 | `--log-full-params` |

Rotate: `gbrain mcp admin invalidate-tokens <CLIENT_ID> … --dry-run` then apply (`docs/mcp/ADMIN.md`). Then `--fresh-token --yes` or a new grant. Expose `--remove` does not revoke clients.

Hourly TTL: schedule the `--fresh-token` connect on each Windows user, or expect first-call failures after 3600s until refreshed.

---

## 6. Storage on mlsfs — DEVIATION

Martin said **"Data on mlsfs."** Closest layout the engines allow:

| Asset | Location | Rebuild from markdown? |
| --- | --- | --- |
| Source markdown (the record) | `I:\personalgrok\gbrain\{personal,business,hermes,shared}\` = `/Volumes/<share>/personalgrok/gbrain/…` | It **is** the record |
| Live PGLite index | Mac APFS `~/.gbrain/brain.pglite` (no symlink) | Re-index via `gbrain sync` + extract; **embeddings cost money if on** |
| Full backup archives | mlsfs `…/gbrain/backups/` (copy from `~/gbrain-backups/` after a local `backup create`) | Restores the DB, including what markdown cannot rebuild |

**This is a DEVIATION:** the live database is not on mlsfs. Martin must approve it. Putting `brain.pglite` on SMB is a bad idea (WAL + kernel lock on a share), but it is **not** a hard `init`/`serve` refusal.

**`network_filesystem` corrected:** that reason is returned by `gbrain pglite-repair --legacy-lock` when it refuses to move a legacy lock on NFS/SMB/9p/virtiofs/FUSE (`src/core/pglite-legacy-lock.ts` ~192–194, `src/core/error-registry.ts` `legacy_lock_removal_refused`). It is **not** an init/serve hard stop. Serve can open a PGLite dir on a share; repair then cannot safely reap a lock, and crash recovery is worse. Keep the data dir on APFS anyway.

**What markdown does not rebuild** (`docs/guides/where-your-memory-lives.md`, `docs/ENGINES.md`): facts with no page, private/db-only pages, page revision history, write receipts, OAuth clients, access tokens, grants, belief ledger. Those live in PGLite and in `backup create` archives only.

**Git on the share:** `gbrain sources add --path` requires a git repo with tracked commits unless `--force` (`src/core/sources-ops.ts`). `git_index_stale` is a **`.git/index.lock` older than ~10 minutes** (or dated in the future) that the writer could not reclaim (`src/core/persistence/effect-git.ts`) — not a blanket "git on SMB fails." SMB makes stale locks more likely; if a lock parks, clear it only when no git is running in that checkout.

Mac mount default: `/Volumes/<share>/personalgrok/gbrain`. Confirm:

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
ls /Volumes
mount | grep -i -E 'smbfs|smb'
df -P /Volumes/<share>/personalgrok/gbrain
touch /Volumes/<share>/personalgrok/gbrain/.write-test && rm /Volumes/<share>/personalgrok/gbrain/.write-test
```

Windows:

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_PERSONAL_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_PERSONAL_HOST>" }; Get-PSDrive I; New-Item -ItemType Directory -Force -Path 'I:\personalgrok\gbrain\backups' | Out-Null }
```

---

## 7. Ops

### 7.1 Expose argv and launchd

Install (Mac):

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp expose --port 8766 --no-install --dry-run --json
gbrain mcp expose --port 8766 --no-install --yes --json
```

That is the real argv. Wrapper becomes `gbrain serve --http --port 8766 --public-url https://<MAC_MAGICDNS>` (plus default `--advertise verbs` from expose's surface defaults). Plist (`src/core/serve-service.ts` `renderServeLaunchdPlist`): Label `com.gbrain.serve`, `RunAtLoad`, `KeepAlive`, `ThrottleInterval` 30, stdout/stderr `~/.gbrain/serve/serve.log` and `serve.err`, **no token in the plist**.

If serve was `bootout` for backup, start it again with this exact bootstrap (missing from r1):

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.gbrain.serve.plist"
```

`launchctl bootout gui/$(id -u)/com.gbrain.serve` stops it. Do not `mcp expose --remove` just to pause for backup (that also tears Tailscale Serve).

### 7.2 Health

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
curl -sf "http://127.0.0.1:8766/health"
curl -sf "https://<MAC_MAGICDNS>/health"
gbrain mcp expose --status --json
```

Do **not** curl `http://0.0.0.0:8766` — that hits loopback and proves nothing.

Off-box checks: from a **LAN host that is not on Tailscale**, `curl --connect-timeout 3 http://<MAC_LAN_IP>:8766/health` must fail. From off-tailnet, `https://<MAC_MAGICDNS>/health` must fail. From the personal Windows tailnet host, MagicDNS `/health` must succeed and `<MAC_LAN_IP>:8766` must fail.

### 7.3 mlsfs down / Tailscale down

mlsfs down: serve keeps working (PGLite is local); source file writes that need the checkout fail; backup copy step fails. Tailscale down: loopback Hermes thin CLI still works; MagicDNS and Grok Bots fail. Mac asleep: everyone down.

### 7.4 Backup + restore (pass criterion)

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
launchctl bootout "gui/$(id -u)/com.gbrain.serve"
mkdir -p "$HOME/gbrain-backups"
gbrain backup create --output "$HOME/gbrain-backups/brain-$(date -u +%Y%m%dT%H%M%SZ).gbrain-backup" --json
cp "$HOME/gbrain-backups/"brain-*.gbrain-backup /Volumes/<share>/personalgrok/gbrain/backups/
# restore drill — destination must not exist:
gbrain backup restore "$HOME/gbrain-backups/<ARCHIVE>.gbrain-backup" --into /tmp/gbrain-restore-test --json
GBRAIN_HOME=/tmp/gbrain-restore-test gbrain recall "projects/live-accept-shared" --json
# PASS: the host-written shared test phrase is present in that recall.
rm -rf /tmp/gbrain-restore-test
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.gbrain.serve.plist"
curl -sf "http://127.0.0.1:8766/health"
```

Pass criterion: the scratch restore's `recall` returns the known shared fact **and** the real host serve is healthy afterwards. Restore is not physical erasure of `forget`.

---

## 8. Fork and upstream sync

Keep grok-specific docs under `docs/grok/` only. r1 and r2 both stay. No core edits. Binary on the Mac: upstream `stable`. Rebase `grok` onto `garrytan/gbrain` master when syncing. Do not touch `master` or `hermes`. No PR for this draft.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| No standing Grok Bot access on (a)/(b) | Decision table; do not sneak `--funnel`. |
| Funnel looks private | It is public HTTPS (`docs/guides/remote-mcp.md`). |
| Shared Windows user reads both tokens | Default (b). |
| Host CLI mistaken for Hermes | 10a uses the hermes thin CLI, not `gbrain remember`. |
| 3600s token expiry | `--fresh-token --yes` on a timer. |
| PGLite + stdio Hermes | Do not `hermes mcp add … serve`. |
| SMB live DB | Deviation: APFS index. |
| `write_pending` treated as failure | Poll write-request; exit 10 is accepted-not-done. |
| LAN curl to 0.0.0.0 | Removed; test `<MAC_LAN_IP>` from another host. |

---

## 10. Open questions (defaults)

| ID | Question | Default |
| --- | --- | --- |
| Q-shared | Who writes `shared`? | **Host CLI only.** Second `--source shared` grant is the alternative. |
| Q-bots | Grok Bot path (a)/(b)/(c)? | **(b)** isolated Windows user/machine. Funnel off. |
| Q-mlsfs | Approve DB-off-share deviation? | **Yes, with markdown + backups on mlsfs.** Needs Martin's OK. |
| Q4 | Mac volume name? | `/Volumes/<share>/personalgrok/gbrain` |
| Q6 | Engine? | PGLite keyless |
| Q7 | Embeddings? | Off |
| Q8 | Windows names? | `<WINDOWS_PERSONAL_HOST>`, `<WINDOWS_BUSINESS_HOST>` |
| Q10 | Skill follow? | `memory-only` |
| Q11 | Which binary? | Upstream stable |
| Q-hermes-http | Native Hermes HTTP later? | Until then, thin CLI fallback |

---

## 11. Ordered build plan

Martin runs these. No installs from this agent.

### Step 1 — Mac + Tailscale

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
hostname -s
tailscale status
tailscale serve status
```

QA: hostname match. No Funnel. HTTPS certs on.

### Step 2 — Xcode CLT, Gatekeeper, Bun, gbrain

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
xcode-select -p || xcode-select --install
git --version
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
# if bun is quarantined:
xattr -d com.apple.quarantine "$HOME/.bun/bin/bun" 2>/dev/null || true
bun --version   # >= 1.4.4
bun install -g github:garrytan/gbrain#stable
gbrain --version
```

### Step 3 — Init

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain init --pglite --no-embedding
gbrain doctor --json
```

Relay the search-mode matrix.

### Step 4 — mlsfs dirs + git + sources

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
ROOT="/Volumes/<share>/personalgrok/gbrain"
for s in personal business hermes shared; do
  mkdir -p "$ROOT/$s"
  git -C "$ROOT/$s" init
  git -C "$ROOT/$s" add -A
  git -C "$ROOT/$s" commit --allow-empty -m "initial $s"
done
gbrain sources add personal --path "$ROOT/personal" --name "personalgrok" --no-federated --json
gbrain sources add business --path "$ROOT/business" --name "businessgrok" --no-federated --json
gbrain sources add hermes --path "$ROOT/hermes" --name "hermes" --no-federated --json
gbrain sources add shared --path "$ROOT/shared" --name "shared" --federated --json
gbrain sources list --json
```

QA: four sources; private ones `federated: false`; `shared` federated.

### Step 5 — expose

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp expose --port 8766 --no-install --dry-run --json
gbrain mcp expose --port 8766 --no-install --yes --json
gbrain mcp expose --status --json
curl -sf "http://127.0.0.1:8766/health"
```

QA: tailnet-only, port 8766, loopback health 200, no Funnel.

### Step 6 — grants + thin CLIs on the Mac (loopback)

Mint the three `-loopback` grants (§4.2–4.3). Then:

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain connect "http://127.0.0.1:8766/mcp" --harness grok-bot --credentials-file "$HOME/.gbrain/serve/credentials/hermes-loopback.json" --root "$HOME/gbrain-clients/hermes" --install --yes
gbrain connect "http://127.0.0.1:8766/mcp" --harness grok-bot --credentials-file "$HOME/.gbrain/serve/credentials/personalgrok-loopback.json" --root "$HOME/gbrain-clients/personalgrok" --install --yes
gbrain connect "http://127.0.0.1:8766/mcp" --harness grok-bot --credentials-file "$HOME/.gbrain/serve/credentials/businessgrok-loopback.json" --root "$HOME/gbrain-clients/businessgrok" --install --yes
```

### Step 7 — verify each loopback client (`--credentials-file` required)

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp verify --client "$(jq -r .client_id "$HOME/.gbrain/serve/credentials/hermes-loopback.json")" --harness grok-bot --url "http://127.0.0.1:8766/mcp" --credentials-file "$HOME/.gbrain/serve/credentials/hermes-loopback.json" --json
gbrain mcp verify --client "$(jq -r .client_id "$HOME/.gbrain/serve/credentials/personalgrok-loopback.json")" --harness grok-bot --url "http://127.0.0.1:8766/mcp" --credentials-file "$HOME/.gbrain/serve/credentials/personalgrok-loopback.json" --json
gbrain mcp verify --client "$(jq -r .client_id "$HOME/.gbrain/serve/credentials/businessgrok-loopback.json")" --harness grok-bot --url "http://127.0.0.1:8766/mcp" --credentials-file "$HOME/.gbrain/serve/credentials/businessgrok-loopback.json" --json
```

### Step 8 — Windows (decision b)

On **each** isolated Windows user/machine (Git for Windows first; then Bun; then gbrain). SmartScreen may block the Bun installer — Martin unblocks it in person. Copy **only** that account's `-tailnet.json` into that user's profile. `connect --install` needs `--yes` when there is no TTY.

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_PERSONAL_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_PERSONAL_HOST>" }; git --version; bun --version; bun install -g github:garrytan/gbrain#stable; gbrain --version }
```

Then the `gbrain connect … --install --yes` line in §4.2. Hourly refresh on that same user:

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_PERSONAL_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_PERSONAL_HOST>" }; gbrain connect "https://<MAC_MAGICDNS>/mcp" --harness grok-bot --credentials-file "$env:USERPROFILE\.gbrain\credentials\personalgrok-tailnet.json" --root "$env:USERPROFILE\gbrain-clients\personalgrok" --install --fresh-token --yes }
```

Mirror on `<WINDOWS_BUSINESS_HOST>` with the business credential and root. Never copy both JSON files onto one profile.

### Step 9 — LIVE ACCEPTANCE

Helpers (Mac). Pending writes: exit 10 → poll. Fail if `source_id` is wrong.

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
H="$HOME/gbrain-clients/hermes/bin/gbrain"
P="$HOME/gbrain-clients/personalgrok/bin/gbrain"
B="$HOME/gbrain-clients/businessgrok/bin/gbrain"
```

Wait-for-commit: if the launcher exits 10, `gbrain write-request <request_id> --json` until `state` is terminal/committed (`docs/protocol/AGENT_OPERATOR_v1.md`). Do not treat 10 as failure.

**10a Hermes** — only `$H`, credential `hermes-loopback.json`, URL loopback:

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
"$H" remember "LIVE-ACCEPT hermes suffix=<RANDOM>" --entity projects/live-accept-hermes --content-origin user_said --provenance "live-accept 2026-11-11" --json
"$H" recall "projects/live-accept-hermes" --json
gbrain get projects/live-accept-hermes --source hermes --json   # host: must exist
gbrain get projects/live-accept-hermes --source personal --json  # host: must be not_found
```

FAIL if the host `--source hermes` get misses, or `--source personal` hits. FAIL if 10a used bare `gbrain remember` (that is owner IPC into `default`).

**10b personalgrok loopback** — only `$P`:

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
"$P" remember "LIVE-ACCEPT personalgrok suffix=<RANDOM>" --entity projects/live-accept-personalgrok --content-origin user_said --provenance "live-accept 2026-11-11" --json
"$P" recall "projects/live-accept-personalgrok" --json
gbrain get projects/live-accept-personalgrok --source personal --json
gbrain get projects/live-accept-personalgrok --source business --json   # must be not_found
```

**10c businessgrok loopback** — only `$B`, entity `projects/live-accept-businessgrok`, host get `--source business` pass / `--source personal` fail.

**10d separation + shared (host-only writes):**

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
# clients MUST NOT see the others' private tests
"$P" recall "projects/live-accept-businessgrok" --json    # empty
"$P" recall "projects/live-accept-hermes" --json          # empty
"$B" recall "projects/live-accept-personalgrok" --json    # empty
"$H" recall "projects/live-accept-personalgrok" --json    # empty
# clients MUST be refused writing shared (no second grant).
# `--source shared` is readable (federated-read) but not writable (grantedWriteSource).
# Omit this flag and remember would silently land in `personal` — that is not this test.
"$P" remember "LIVE-ACCEPT shared-from-personal suffix=<RANDOM>" --entity projects/live-accept-shared --source shared --content-origin user_said --provenance "must-fail" --json
# expect permission_denied / write grant refusal — FAIL the accept if this commits
# host (trusted) writes shared
gbrain remember "LIVE-ACCEPT shared-from-host suffix=<RANDOM>" --entity projects/live-accept-shared --source shared --content-origin user_said --provenance "live-accept 2026-11-11" --json
gbrain get projects/live-accept-shared --source shared --json   # must exist
"$P" recall "projects/live-accept-shared" --json   # must see host fact
"$B" recall "projects/live-accept-shared" --json
"$H" recall "projects/live-accept-shared" --json
```

**10b-bot / 10c-bot** (decision b, real Bot path): from personalgrok, approved shell on `<WINDOWS_PERSONAL_HOST>` only, that user's launcher, write+recall a distinct phrase. That session must not have a path to `businessgrok-tailnet.json`. Mirror for businessgrok. FAIL if either Bot can read the other's credential file.

**10e off-tailnet** — from another LAN host and from a device off Tailscale:

```text
curl -sf --connect-timeout 3 "http://<MAC_LAN_IP>:8766/health"     # must fail
curl -sf --connect-timeout 5 "https://<MAC_MAGICDNS>/health"       # must fail off-tailnet
```

From personal Windows (on tailnet):

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_PERSONAL_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_PERSONAL_HOST>" }; curl.exe -sf --connect-timeout 3 "http://<MAC_LAN_IP>:8766/health"; echo "LAN=$LASTEXITCODE"; curl.exe -sf "https://<MAC_MAGICDNS>/health"; echo "TS=$LASTEXITCODE" }
```

LAN fail, Tailscale success. Funnel-off: `--status` must not report funnel.

**10f restore drill** — §7.4. PASS only if scratch `recall` of `projects/live-accept-shared` shows the host phrase and live serve returns 200 after `launchctl bootstrap`.

Cleanup: `forget` test fact ids. Backups taken before forget may still contain them.

Acceptance **pass** only if 10a–10d use loopback thin CLIs (not host `gbrain` for client writes), source_id checks fail closed, shared client writes are refused, 10b-bot/10c-bot cannot see the other credential, 10e shows LAN/public closed, and 10f restore recalls the known fact.

---

## Round-1 fix map

| # | Sev | Finding | Round-2 fix |
| --- | --- | --- | --- |
| 1 | H | `--federated-read` cannot write `shared`; 10d would be refused | Host-only writes to `shared` (`grantedWriteSource`, `assertSourceInCallerWriteScope`). Q-shared default. 10d expects client `permission_denied` then host write + client read. |
| 2 | H | Grok Bot path not standing and not isolated on one Windows user | §4.1 DECISION (a)/(b)/(c). Default **(b)**. (a)(b) still need per-call approval; only (c) does not, and (c) is public HTTPS. 10b-bot/10c-bot require no access to the other credential. |
| 3 | H | "Data on mlsfs" overridden; `network_filesystem` overstated | §6 DEVIATION: markdown on `I:\personalgrok\gbrain\`, PGLite on APFS, backups on mlsfs. `network_filesystem` cited as pglite-repair `--legacy-lock` only. List of what markdown does not rebuild. |
| 4 | M | 10a used host `gbrain remember` (owner IPC, `default`) | 10a–10d use `$HOME/gbrain-clients/<client>/bin/gbrain` against `http://127.0.0.1:8766/mcp`. Handle exit 10. Host `get --source` must match; wrong source `not_found`. |
| 5 | M | No real Hermes HTTP client; `generic` has no thin CLI | Stated: `hermes` is stdio-only. Fallback: thin CLI `--harness grok-bot --root … --install --yes`. Do not stdio-serve beside HTTP PGLite. `gbrain setup hermes` noted as stdio-only. |
| 6 | M | Missing git/Xcode CLT, Gatekeeper, Windows install, `connect --yes` | Step 2 + §2.2. Windows Git+Bun. `connect --install --yes` (`src/commands/connect.ts`). |
| 7 | M | Fake `--bind` in diagram; no 3600s refresh; verify missing `--credentials-file`; `0.0.0.0` curl | Expose argv only `--port 8766 --no-install --yes`. TTL 3600 + `--fresh-token`. verify always `--credentials-file`. 10e uses `<MAC_LAN_IP>` and off-tailnet MagicDNS. |
| 8 | M | Federated-by-default host search; tokens must stay scoped | `--no-federated` on private sources; `--federated` on `shared`. Tokens `--source` + `--federated-read` only. No `operator`/`full`/unscoped `auth create`. |
| 9 | M | Missing `launchctl bootstrap`; restore not a pass criterion | §7.1 bootstrap line. §7.4 / 10f restore-to-scratch + recall of known shared fact. |
| 10 | L | Privacy | Still placeholders only (`<MAC_MAGICDNS>`, `<MAC_LAN_IP>`, `<MAC_TS_IP>`, `<share>`, host names). No 100.x, emails, or account ids. |
| 11 | L | `git_index_stale` overclaim; `gbrain setup hermes` exists | Stale `index.lock` only (`effect-git.ts`). `setup hermes` cited as stdio SOUL.md helper, not an HTTP path. |
