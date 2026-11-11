# DRAFT, NOT YET REVIEWED / NOT YET INSTALLED

# Shared gbrain knowledge store: two Grok Bot accounts + Hermes

**Say to your agent:** *"Stand up one gbrain on the Mac mini, Tailscale-only, with separate memory for personalgrok, businessgrok and Hermes, and backups on mlsfs."*

Today: Wednesday 11 Nov 2026. This is a design for Martin to install in person. It does not install, configure, or change any code. It is the only file this task adds (`docs/grok/gbrain-shared-brain-design.md` on branch `grok`).

Martin's request (authoritative, verbatim): *"Using designer using a cloud model ask how to use this GrokBot knowledge from two accounts and Hermes and put this in the grok section. Data on mlsfs and run from the Mac. Only available through tsilscale"* (tsilscale = Tailscale).

---

## 1. Summary and recommendation

**One brain, on the Mac mini, published tailnet-only.** Three clients (personalgrok, businessgrok, Hermes) share that brain. Each client gets its own source plus read/write on a `shared` source. Live database stays on the Mac's local disk. mlsfs holds backups and an optional markdown mirror, not the live PGLite directory.

**Recommended connection path (one choice):** keep the HTTP MCP server **tailnet-only** (`gbrain mcp expose --port 8766`, **no** `--funnel`). Hermes talks to loopback on the Mac. The two Grok Bot accounts reach the brain through a **Windows tailnet machine** they can already drive with a machine-targeted shell: that Windows host runs the thin gbrain CLI against the Mac's MagicDNS HTTPS URL. Traffic never leaves the tailnet.

That honors "only available through Tailscale." The trade-off is explicit: **Grok Bot MCP connectors (a URL added in the Bot) cannot reach a tailnet-only server**, because the Bot runtime is a vendor-cloud Linux box that is not on the tailnet. Upstream's documented standing path for Grok Bot is `gbrain mcp expose --funnel`, which publishes public HTTPS on the same `*.ts.net` name and **breaks "only through Tailscale"** — gbrain OAuth/bearer still applies, but Tailscale ACLs no longer gate who can knock. Do not enable Funnel unless Martin accepts that exception.

Do not bind `0.0.0.0`, the LAN, or a wildcard. Do not put the live database on the SMB share.

| Client | How it reaches the brain (recommended) |
| --- | --- |
| Hermes (on the Mac mini) | HTTP MCP to `http://127.0.0.1:8766/mcp` (loopback HTTP is the one plaintext URL gbrain's credential handoff allows) **or** HTTPS MagicDNS on the tailnet. Not a second `gbrain serve` stdio process: PGLite is single-writer. |
| personalgrok (Grok Bot, vendor cloud) | Machine-targeted shell on a Windows tailnet host → thin CLI / `gbrain` against `https://<MAC_MAGICDNS>/mcp` with the personalgrok grant. |
| businessgrok (Grok Bot, vendor cloud) | Same Windows relay, **separate** grant and credential file, business source. |

---

## 2. What upstream gbrain is and needs

Verified from this checkout at `64de25c0` (same commit on `master`, `hermes`, `grok`, and upstream). Nothing below is an invented feature.

### 2.1 Product

GBrain is a personal knowledge brain. Markdown files with YAML frontmatter are the record; an embedded or server Postgres index powers search and facts (`docs/guides/where-your-memory-lives.md`). CLI and MCP are generated from `src/core/operations.ts`. Two engines implement every `BrainEngine` method (`docs/ENGINES.md`, `src/core/engine.ts`):

| Engine | What it is | When this design uses it |
| --- | --- | --- |
| **PGLite** (`@electric-sql/pglite`) | Embedded Postgres in WASM. Default. Data at `~/.gbrain/brain.pglite` (configurable). No server, no Docker, no account. Single-writer. | **Default for this Mac.** |
| **Postgres + pgvector** | Self-hosted Postgres or Supabase. Concurrent clients. | Later, if the brain grows past ~1000 files or Hermes must keep a stdio `gbrain serve` next to HTTP. |

It is **not SQLite**. Keyword search works with no embedding key. Vector search needs an embedding provider.

Two orthogonal axes (`docs/architecture/brains-and-sources.md`):

- **Brain** = which database (`--brain`, `GBRAIN_BRAIN_ID`).
- **Source** = which repo inside that database (`--source`, `GBRAIN_SOURCE`). Slug uniqueness is `(source_id, slug)`. Remote grants are scoped per source (`gbrain mcp grant … --source … --federated-read …`, `src/commands/mcp.ts`).

### 2.2 Runtime (what Martin must install)

Verified from `package.json` `"engines": { "bun": ">=1.4.4" }`, `src/core/runtime-version.ts` (`MINIMUM_BUN_VERSION = '1.4.4'`), `docs/INSTALL.md`, `AGENTS.md`, `docs/ENGINES.md`.

| Need | Required? | Works without Homebrew? | How Martin installs it |
| --- | --- | --- | --- |
| **Bun ≥ 1.4.4** | Yes. This is the runtime. | **Yes.** Official installer, no brew. | `curl -fsSL https://bun.sh/install \| bash` then `export PATH="$HOME/.bun/bin:$PATH"`. Installs into `~/.bun`. |
| **gbrain CLI** | Yes. | **Yes**, once Bun exists. | `bun install -g github:garrytan/gbrain#stable` (or clone + `bun link` if postinstall is blocked; `docs/INSTALL.md`). |
| **Node.js** | No for running gbrain. `package.json` engines list only Bun. Contributors use Node to run `tsc`; the Mac mini service does not. | n/a | Skip. |
| **Python 3.9** | No. | n/a | The system Python is unused. |
| **PGLite** | Default engine. Bundled with gbrain (`@electric-sql/pglite` is a `trustedDependency`). | **Yes.** No Postgres server. | `gbrain init --pglite --no-embedding`. |
| **Postgres 17 + pgvector** | Optional. `docs/ENGINES.md` "Local Postgres" shows `brew install postgresql@17` plus a pgvector source build. | Homebrew path: **no**. Without brew: Postgres.app (official `.dmg`), EDB installer, Docker Desktop `.dmg` + `gbrain init --prefer-postgres --allow-docker`, or hosted Supabase. | **Do not install for v1.** Revisit if PGLite's single-writer or 2 GiB WASM ceiling hurts. |
| **Embedding API key** | No for keyword memory. Yes for semantic search. Default embedding is Voyage `voyage-4` (`VOYAGE_API_KEY`); OpenAI is the alternative (`OPENAI_API_KEY`). Chat/extraction uses Anthropic else OpenAI (`docs/INSTALL.md`). `--no-embedding` stays keyless until Martin opts in. Adding a key later does not enable embeddings by itself; the CLI has an explicit activation path. | Keys only, no brew. | Skip on day one. Confirm the search-mode matrix `gbrain init` prints (`INSTALL_FOR_AGENTS.md` Step 3.5) before leaving the default. |
| **Tailscale** | Already on this Mac (task fact: Tailscale IP exists). `gbrain mcp expose` finds `tailscale` on PATH / usual macOS locations. If it were missing, the macOS install path is `brew install --cask tailscale-app` (`docs/guides/remote-mcp.md`) — **do not use that**; Tailscale is present. Pass `--no-install` so expose will not try brew. | Already installed. | Sign-in + MagicDNS + HTTPS certificates at https://login.tailscale.com/admin/dns. Do **not** enable Funnel. |
| **launchd** | Used by `gbrain mcp expose` on darwin (`src/core/serve-service.ts`, label `com.gbrain.serve`). | Built into macOS. | Installed by expose; do not hand-roll unless expose is rejected. |

Martin installs everything in person. This doc lists the commands; it does not run them.

### 2.3 Serve, expose, grants (verified)

- `gbrain serve --http` defaults to **`127.0.0.1`** since v0.34.1 (`src/commands/serve-http.ts`). `--bind 0.0.0.0` is the documented remote-all-interfaces flag; this design never uses it. A specific interface IP is allowed by the flag, but see §3.2 for why we still bind loopback.
- `gbrain mcp expose` publishes that server on Tailscale, installs the user service, writes `~/.gbrain/serve/admin-token` (0600, never printed), keeps `gbrain serve --http` on loopback, and has Tailscale terminate TLS (`docs/guides/remote-mcp.md`). Default port **3131**. Default mode **tailnet-only**. `--funnel` is the public exception for cloud agents.
- Machine grants: `gbrain mcp grant NAME --harness ID --profile memory-writer --source SOURCE --url HTTPS --admin-token-file … --credentials-out FILE`. Profiles: `memory-reader`, `memory-writer`, `coding-agent`, `operator`, `delegating-agent`, `full` (`docs/guides/hosted-harness-access.md`). Use `memory-writer`, never `operator`.
- Credential URLs **must be HTTPS**, except loopback HTTP: `src/core/harness/credentials.ts` `assertSecureEndpoint` allows `https:` or `http:` only for `localhost` / `127.0.0.1` / `[::1]`. A grant whose URL is `http://<MAC_TS_IP>:8766/mcp` is refused ("Use HTTPS for credential delivery; HTTP is supported only on loopback").
- Grok Bot harness id is `grok-bot` (thin-cli). Native Grok Bot MCP plugin auth is **unverified and release-gated** (`docs/guides/grok-bot.md`). An actual Grok Bot account has **not** been used to verify the integration; Tailscale publish is tested with a fake Tailscale runner.
- Hermes harness id is `hermes`. Upstream Hermes (NousResearch `hermes-agent`) spawns **stdio** `gbrain serve` — "No server, no tunnel, no token" (`docs/mcp/HERMES.md`). Registry modes for `hermes` are `['stdio']` only (`src/core/harness/registry.ts`). Martin's agent is a **private repo** (not this tree; path kept out of this public file as `<HERMES_PRIVATE_REPO>`); its HTTP/MCP capabilities are **assumed**, not verified here.
- PGLite while HTTP serve runs: host commands that open the database fail fast with `live_serve`. Exceptions: `gbrain sync` and `gbrain sweep --once` delegate into the live serve. `gbrain backup create` holds the PGLite writer lock (`docs/guides/in-agent-setup.md`) and is **not** listed as a live-serve delegate — treat backups as stop-serve, dump, start-serve.
- `gbrain backup create --output <absolute path>` writes a checksummed archive (mode 0600) of the full PGLite database plus managed files. Markdown export is not a full backup. Cap 8 GiB; data dir must be the managed `<root>/.gbrain/brain.pglite` with no symlink (`unmanaged_database_path` otherwise).

### 2.4 What this design assumes (not in this repo)

- Grok Bot accounts **personalgrok** (personal) and **businessgrok** (business) exist and can (a) add remote HTTP/SSE MCP servers by URL, and (b) run a **machine-targeted shell on Martin's tailnet Windows machines**, with **approval each time**, not a standing route. (Task facts.)
- Those two accounts are **separate Grok accounts** (separate cloud computers). Upstream `docs/guides/grok-bot.md` "One shared brain for your Bots" describes multiple Bots **on one account** sharing `/workspace`; that is a different shape. If these two accounts ever share a computer, sources do not isolate files on that disk.
- Hermes runs on the Mac mini. How it registers MCP (stdio vs HTTP vs shelling out to `gbrain`) is assumed; see §4.3.
- mlsfs is a Windows share at `I:\personalgrok\gbrain\`. The Mac mount point is an open question (§6, §10).
- A Windows tailnet host exists that Grok Bot can target. Its `COMPUTERNAME` is `<WINDOWS_TAILNET_HOST>` until Martin fills it in.
- martin-finance-web already binds the Mac Tailscale IP on **port 8765**. This design uses **8766** for gbrain's local HTTP port so the two never share a port. Tailscale Serve still fronts gbrain on `:443` of the MagicDNS name.

---

## 3. Architecture

### 3.1 Diagram

```
                         ┌─────────────────────────────────────────────┐
                         │ Vendor cloud (NOT on the tailnet)           │
                         │  Grok Bot "personalgrok"                    │
                         │  Grok Bot "businessgrok"                    │
                         │  MCP URL connectors cannot reach MagicDNS   │
                         └───────────────┬─────────────────────────────┘
                                         │ machine-targeted shell
                                         │ (approval each time; not standing)
                                         ▼
                         ┌─────────────────────────────────────────────┐
                         │ Windows tailnet host <WINDOWS_TAILNET_HOST> │
                         │  thin gbrain CLI                            │
                         │  0600 credential files (one per Bot)        │
                         │  HTTPS client → https://<MAC_MAGICDNS>/mcp  │
                         └───────────────┬─────────────────────────────┘
                                         │ Tailscale (WireGuard)
                                         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Mac mini "macmini48" / hostname Martins-Mac-mini                         │
│ Tailscale IP <MAC_TS_IP>  (published as placeholder; never 0.0.0.0)      │
│                                                                          │
│  Hermes ──HTTP MCP──► 127.0.0.1:8766  (loopback; credential-legal HTTP)  │
│                                                                          │
│  launchd com.gbrain.serve  KeepAlive                                     │
│    └── ~/.gbrain/serve/gbrain-serve.sh                                   │
│          └── gbrain serve --http --port 8766 --bind 127.0.0.1            │
│                └── PGLite ~/.gbrain/brain.pglite   (local APFS)          │
│                                                                          │
│  Tailscale Serve (NO Funnel):  :443 on <MAC_MAGICDNS>  →  127.0.0.1:8766 │
│                                                                          │
│  Sources in one host brain:                                              │
│    personal  (personalgrok writer)                                       │
│    business  (businessgrok writer)                                       │
│    hermes    (Hermes writer)                                             │
│    shared    (all three read+write)                                      │
│    default   (host/admin only; not granted to the three clients)         │
└───────────┬──────────────────────────────────────────────────────────────┘
            │ scheduled (serve briefly stopped)
            ▼
┌─────────────────────────────────────────────┐
│ mlsfs  Windows I:\personalgrok\gbrain\      │
│ Mac    /Volumes/<share>/personalgrok/gbrain │
│   backups/*.gbrain-backup                   │
│   markdown-mirror/   (optional)             │
│   NOT the live brain.pglite directory       │
└─────────────────────────────────────────────┘
```

### 3.2 Ports and binds

| Listener | Bind | Port | Who may connect |
| --- | --- | --- | --- |
| `gbrain serve --http` | `127.0.0.1` only | **8766** | This Mac (Hermes, health checks, expose verify). |
| Tailscale Serve | MagicDNS `:443` (HTTPS) | proxies to 8766 | Tailnet devices only. Windows relay, other Macs on the tailnet. |
| Tailscale Funnel | (not enabled) | — | Would be the public internet. **Off.** |
| LAN / wildcard / `0.0.0.0` | never | — | — |

**Why not bind `<MAC_TS_IP>` the way martin-finance-web binds 8765?** Martin's instruction was: bind the Tailscale IP only, never `0.0.0.0`, the LAN, or a wildcard. For gbrain that literal bind fights two verified facts:

1. `gbrain serve --http` is HTTP, not TLS. Machine grants refuse non-loopback `http://` (`src/core/harness/credentials.ts`).
2. `gbrain mcp expose` is built to keep serve on loopback and let Tailscale terminate HTTPS (`docs/guides/remote-mcp.md` "Loopback bind. The server keeps `127.0.0.1`; never pass `--bind 0.0.0.0` for this shape. Tailscale is the only way in.").

So the security intent ("only through Tailscale") is met by **loopback + Tailscale Serve**, which is stricter than a plaintext listener on `<MAC_TS_IP>:8766`. Other tailnet hosts cannot hit 8766 directly; they must use MagicDNS `:443`. If Martin later insists on a Tailscale-IP bind like martin-finance-web, it still must sit behind HTTPS (Tailscale cert + a terminator). Do not ship plaintext HTTP on `100.x` for gbrain grants. Open question Q1, default = loopback + Serve.

Default local port is 3131 in expose. This design uses **8766** so it is obviously "the other Mac-mini Tailscale service" next to martin-finance-web:8765 and does not collide with a leftover 3131 listener (`foreign_listener` in expose).

### 3.3 Data flow (write)

1. Client authenticates (bearer from `mcp grant` handoff, or Hermes loopback grant).
2. HTTP MCP `remember` / `put_page` / `capture` enters `gbrain serve --http` with `OperationContext.remote = true` (`src/mcp/server.ts` sets remote for agent-facing callers; CLI is `remote: false`).
3. Grant source + federated-read fences the write. A page lands in that source's folder under the content root and in PGLite.
4. Keyword search sees it immediately. Vector search waits on the embedding effect if embeddings are on (`docs/guides/remote-mcp.md` "Writing many pages").
5. Remote `put_page` does not extract typed graph edges inline; a post-commit `links` effect may add plain mention edges to pages the writer can see (`mcp.remote_auto_links`, default on). Typed edges need host maintenance or `add_link` (`docs/guides/memory-boundaries.md`).

### 3.4 Data flow (read)

Same door. `search` / `query` / `recall` / `get_page` are filtered by the token's sources. Cross-source leakage is a missed `sourceScopeOpts` on the server; clients must not be given `operator` or an unscoped token.

---

## 4. Connection path for each client

Options for a cloud Grok Bot to reach a Tailscale-only service:

| Option | Standing? | Honors "only through Tailscale"? | Verified in this repo? |
| --- | --- | --- | --- |
| **A. Windows tailnet relay** (machine-targeted shell → thin CLI → MagicDNS HTTPS) | No. Task fact: approval each time. | **Yes.** | Grok Bot thin-cli adapter and `gbrain connect --harness grok-bot --root /workspace/gbrain` are documented (`docs/guides/grok-bot.md`, `src/core/harness/registry.ts`). The Windows-shell hop itself is a task fact, not a gbrain feature. |
| **B. Tailscale Funnel** (`gbrain mcp expose --funnel`) | Yes. Bot adds `https://<MAC_MAGICDNS>/mcp` as an MCP connector. | **No. This is public HTTPS.** Auth still required. | **Yes.** This is the documented Grok Bot path (`docs/guides/remote-mcp.md` table "Cloud agents… `--funnel`"; `docs/guides/grok-bot.md`). |
| **C. Userspace `tailscaled` in the Bot** with an ephemeral auth key | Would be standing if the vendor allows it. | Yes, if the node joins the tailnet. | **No.** "Advanced; not automated and not verified against a real vendor runtime" (`docs/guides/remote-mcp.md`). |
| **D. Other public ingress** (ngrok, Cloudflare Tunnel, cloud host) | Yes. | **No.** Same break as Funnel. | ngrok recipe exists (`docs/guides/remote-mcp.md` Alternatives). |
| **E. In-Bot local gbrain** (`docs/guides/in-agent-setup.md`) | Yes, but it is a **different brain** on the vendor VM, not the Mac/mlsfs store. | n/a | Documented as the no-always-on-machine fallback. **Rejected** for this design. |

**Recommend A.** Trade-off against Martin's "only available through Tailscale": A keeps that promise and uses a capability the Bots already have. The cost is UX: every session needs shell approval, MCP URL connectors stay unused, and a Windows host must stay on the tailnet. If Martin later wants standing MCP in the Bot composer, the documented upgrade is B, and that sentence must be re-litigated as a public-endpoint exception.

### 4.1 personalgrok

On the Mac (after expose + grant; see §11):

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp grant personalgrok --harness grok-bot --profile memory-writer \
  --source personal --federated-read personal,shared --skills memory-only \
  --url "https://<MAC_MAGICDNS>/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/credentials/personalgrok.json" \
  --dry-run --json
```

Move that 0600 file to the Windows host through a private channel (USB, tailnet `scp`, not chat). On Windows:

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_TAILNET_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_TAILNET_HOST>" }; New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.gbrain\credentials" | Out-Null; icacls "$env:USERPROFILE\.gbrain\credentials" /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" }
```

Inside a personalgrok session, ask the Bot to run a machine-targeted shell on `<WINDOWS_TAILNET_HOST>` that invokes the absolute thin-CLI launcher (after `gbrain connect … --harness grok-bot --install --root <WINDOWS_GBRAIN_ROOT>` once). Every memory call uses that launcher, never a token in the command line. Verify with `gbrain mcp verify` from that Windows environment (`docs/guides/hosted-harness-access.md`).

Do not paste the credential JSON into Grok chat. Do not store it on the vendor-cloud `/workspace` if the Windows host can hold it.

### 4.2 businessgrok

Same shape, different grant:

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp grant businessgrok --harness grok-bot --profile memory-writer \
  --source business --federated-read business,shared --skills memory-only \
  --url "https://<MAC_MAGICDNS>/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/credentials/businessgrok.json" \
  --dry-run --json
```

Separate file, separate Bot account, separate source. Do not reuse personalgrok's token.

### 4.3 Hermes

**Verified:** a second `gbrain serve` (Hermes' upstream stdio recipe) cannot open the same PGLite brain while `com.gbrain.serve` holds it (`live_serve` / `pglite_lock`, `docs/guides/remote-mcp.md` "PGLite brains").

**Assumed:** Martin's Hermes can either (1) add an HTTP MCP server URL, or (2) run shell commands, including the thin CLI. Default = (1) loopback HTTP, because it needs no Tailscale and stays up if the tailnet drops.

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp grant hermes-local --harness generic --profile memory-writer \
  --source hermes --federated-read hermes,shared --skills memory-only \
  --url "http://127.0.0.1:8766/mcp" \
  --admin-token-file "$HOME/.gbrain/serve/admin-token" \
  --credentials-out "$HOME/.gbrain/serve/credentials/hermes.json" \
  --dry-run --json
```

`--harness generic` is deliberate: the registry's `hermes` adapter is stdio/manual (`src/core/harness/registry.ts`). Do not claim `gbrain setup hermes` / `hermes mcp add gbrain --command gbrain --args serve` until the live HTTP serve is stopped or the engine is Postgres. If Martin's Hermes only supports stdio MCP, the fallback is: Hermes runs `gbrain` thin-CLI over loopback (same grant), **or** graduate to Postgres so a stdio serve can coexist (open question Q3).

---

## 5. Auth and knowledge separation

### 5.1 Recommended default (one brain, four sources)

Martin owns all three clients, so this is a **source** boundary, not a **brain** boundary (`docs/architecture/brains-and-sources.md` rule of thumb). Separate brains would block cross-query unless mounts are added; that is stronger isolation than requested.

| Source id | Who writes | Who reads | Purpose |
| --- | --- | --- | --- |
| `personal` | personalgrok | personalgrok only | Personal account memory |
| `business` | businessgrok | businessgrok only | Business account memory |
| `hermes` | Hermes | Hermes only | Mac-mini agent memory |
| `shared` | all three | all three | Facts Martin wants everywhere |
| `default` | host/admin (local CLI, `remote: false`) | not granted to the three | Init leftover; do not point Bots at it |

Grant shape (each client): `--profile memory-writer --source <own> --federated-read <own>,shared --skills memory-only`.

`--skills memory-only` opts out of following published skillpacks (`docs/guides/hosted-harness-access.md`). Shared skills never authorize scripts; still, these clients should not enroll in skill follow until Martin asks.

Do **not** enable `--enable-dcr`. Do **not** grant `operator` or `full`. Do **not** mint a `gbrain auth create` token without `--scopes` (that is full access, `docs/mcp/ADMIN.md`).

**Open question Q2:** should businessgrok ever read `personal` (or vice versa)? Default: **no**. Put anything both should see in `shared`.

### 5.2 Where credentials live

| Secret | Store | Mode / ACL | Never |
| --- | --- | --- | --- |
| Owner admin bootstrap | `~/.gbrain/serve/admin-token` on the Mac (created by expose) | 0600 | plist, wrapper, chat, git, logs |
| Provider keys (if any later) | `~/.gbrain/env` (0600, sourced by the wrapper) or macOS Keychain via a line in that file (`docs/INSTALL.md` shows `VOYAGE_API_KEY="$(op read …)"`) | 0600 | `~/.gbrain/config.json` committed anywhere; serve.log |
| personalgrok / businessgrok / hermes handoffs | Mac: `~/.gbrain/serve/credentials/<name>.json` (0600). Windows: `%USERPROFILE%\.gbrain\credentials\<name>.json` (current-user ACL). Optional: macOS Keychain item, Windows Credential Manager. Grok Bot secret store only if the Windows host cannot hold the file. | 0600 / user ACL | Chat, transcripts, `docs/`, git, launchd plist `EnvironmentVariables`, `serve.log` |
| Tailscale auth | Tailscale app / node key already on the Mac | — | Funnel; logging `tailscale status` into a public gist |

`gbrain mcp expose` already loads the admin token at **run time** from the file; it never lands in the plist, unit, or wrapper (`src/core/serve-service.ts`). Keep that invariant in any hand-rolled plist.

`gbrain config get` redacts secrets unless `--raw`. `gbrain serve --http --log-full-params` is off by default and must stay off (it writes payloads to `mcp_request_log`). Serve log rotation: 10 MiB × 5 files, line dedupe (`docs/guides/remote-mcp.md`); still treat `serve.log` / `serve.err` as possibly sensitive and keep them on the Mac, not mlsfs.

### 5.3 Rotation

Preview, then apply, using the owner API against the live server (so PGLite's lock is not stolen):

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp admin clients --url "https://<MAC_MAGICDNS>/mcp" --admin-token-file "$HOME/.gbrain/serve/admin-token" --json
# invalidate one client (docs/mcp/ADMIN.md):
gbrain mcp admin invalidate-tokens <CLIENT_ID> --url "https://<MAC_MAGICDNS>/mcp" --admin-token-file "$HOME/.gbrain/serve/admin-token" --dry-run --json
```

Then mint a fresh grant `--credentials-out` to a **new** path, replace the Windows/Hermes file, delete the old file. Rotating the client secret does not invalidate already-issued access tokens; `invalidate-tokens` does (`docs/guides/hosted-harness-access.md`). Removing expose (`--remove`) does **not** revoke clients.

### 5.4 What does *not* separate knowledge

- Separate Bot **names** on one Grok account (not this design's shape, but documented).
- Putting files in different folders on mlsfs without source-scoped grants.
- Hermes stdio vs HTTP, if they used the same unscoped token.
- `federated=true` (the source default): host-side `gbrain query` with no `--source` searches every federated source. The **tokens** are the isolation for the three clients. Local CLI on the Mac is trusted (`remote: false`) and can see everything — treat the Mac login as root.

---

## 6. Storage on mlsfs, mount, and DB placement

### 6.1 Can the live database live on SMB?

**No. Not PGLite, not Postgres, not "SQLite-on-the-share."**

Verified:

- PGLite is a directory of Postgres files plus a sibling kernel lock `<data-dir>.gbrain-owner.lock`. `gbrain pglite-repair --legacy-lock` **refuses** when the data dir is on NFS, SMB, 9p, virtiofs or FUSE (`network_filesystem`) because another host might still be writing (`docs/ENGINES.md`). That is the same class of bug SQLite-on-SMB is famous for; gbrain does not use SQLite, but the lock/WAL story is the same shape.
- `gbrain backup create` refuses a data dir reached through a **symlink** (`unmanaged_database_path`). An alias from `~/.gbrain/brain.pglite` to `/Volumes/<share>/…` is not a supported layout.
- Postgres `PGDATA` on SMB is not a gbrain-supported path; `docs/ENGINES.md` local Postgres uses a local Homebrew/Docker/Postgres.app data directory.
- Belief ledger, facts without pages, revisions, tokens, and OAuth rows live **only in the database**. Markdown on mlsfs cannot rebuild them (`docs/guides/where-your-memory-lives.md`, `docs/ENGINES.md`).

**Safe pattern (recommended):**

| What | Where | Why |
| --- | --- | --- |
| Live PGLite | Mac APFS `~/.gbrain/brain.pglite` (no symlink) | Local kernel lock, WAL, single writer |
| Live markdown sources | Mac APFS under `~/.gbrain/content/…` (init default) or `~/gbrain-sources/<id>` | Git index locks on SMB are a known failure class (`git_index_stale` / network filesystem in `docs/guides/write-refusals.md`) |
| Full DB backup archives | Write to `~/gbrain-backups/*.gbrain-backup` (local), then **copy** to mlsfs `…/gbrain/backups/` | Archive is checksummed, not encrypted; mlsfs is the off-disk copy. Copy after create so a torn SMB write cannot corrupt the only dump. |
| Optional markdown mirror | rsync/copy of source folders to mlsfs **after** a successful backup | Convenience for reading from Windows; not the restore path for facts |

### 6.2 Mac mount — open question Q4

Default until Martin confirms:

```text
/Volumes/<share>/personalgrok/gbrain
```

Windows: `I:\personalgrok\gbrain\`.

How to verify (Mac):

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
ls /Volumes
mount | grep -i -E 'smbfs|smb|mlsfs'
df -P /Volumes/<share>/personalgrok/gbrain
test -d /Volumes/<share>/personalgrok/gbrain || mkdir -p /Volumes/<share>/personalgrok/gbrain
touch /Volumes/<share>/personalgrok/gbrain/.write-test && rm /Volumes/<share>/personalgrok/gbrain/.write-test
```

How to verify (Windows):

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_TAILNET_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_TAILNET_HOST>" }; Get-PSDrive I; New-Item -ItemType Directory -Force -Path 'I:\personalgrok\gbrain\backups' | Out-Null; 'ok' | Set-Content 'I:\personalgrok\gbrain\backups\.write-test.txt'; Remove-Item 'I:\personalgrok\gbrain\backups\.write-test.txt' }
```

If Finder mounts the share under a different volume name, replace `<share>` and record the real path in a **private** note, not in this public repo.

### 6.3 Backup procedure (live PGLite + launchd)

1. Confirm hostname.
2. `gbrain mcp expose --status --json` (service up).
3. Stop the serve job so `backup create` can take the writer lock: `launchctl bootout gui/$(id -u)/com.gbrain.serve` (or the expose `--remove` is **wrong** here — that also tears Tailscale Serve). Prefer `launchctl bootout` then backup then `launchctl bootstrap` of the same plist; KeepAlive will otherwise race. Document the exact pair in the runbook when installing.
4. `gbrain backup create --output "$HOME/gbrain-backups/brain-$(date -u +%Y%m%dT%H%M%SZ).gbrain-backup" --json`
5. `cp` the archive to `/Volumes/<share>/personalgrok/gbrain/backups/` and `shasum -a 256` both copies.
6. Start serve again; `curl -sf "http://127.0.0.1:8766/health"` until 200.
7. Restore drill (rare, needs an absent target): `gbrain backup restore <archive> --into /tmp/gbrain-restore-test` then `GBRAIN_HOME=/tmp/gbrain-restore-test gbrain doctor --json`. Delete the test root. `forget` is not physical erasure; a restore can resurrect withdrawn facts (`docs/guides/in-agent-setup.md`).

The archive **may contain secrets** (full DB, including tokens). mlsfs ACL must be as tight as `I:\personalgrok\`. Do not upload archives to git or chat.

---

## 7. Ops

### 7.1 Launchd (use expose's unit; sketch for QA)

Do not hand-roll a second agent if `gbrain mcp expose --port 8766` succeeds. It writes:

- Wrapper `~/.gbrain/serve/gbrain-serve.sh` (0755, no token in the file)
- Plist `~/Library/LaunchAgents/com.gbrain.serve.plist` (0644; launchd rejects group-writable agents)
- Logs `~/.gbrain/serve/serve.log` and `serve.err`
- Receipt `~/.gbrain/serve/expose.json` (0600, no secrets)

Sketch matching `src/core/serve-service.ts` `renderServeLaunchdPlist` (paths illustrative):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gbrain.serve</string>
  <key>ProgramArguments</key><array>
    <string>/Users/<mac-user>/.gbrain/serve/gbrain-serve.sh</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/<mac-user></string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/Users/<mac-user>/.gbrain/serve/serve.log</string>
  <key>StandardErrorPath</key><string>/Users/<mac-user>/.gbrain/serve/serve.err</string>
</dict>
</plist>
```

No `EnvironmentVariables` for tokens. The wrapper `cat`s `admin-token` into `GBRAIN_ADMIN_BOOTSTRAP_TOKEN` at start (`src/core/serve-service.ts`). `ThrottleInterval` 30s avoids a crash loop melting the Mac if the brain cannot open (status-only mode is better: serve stays up on 503, `docs/mcp/DEPLOY.md`).

Expose also runs `tailscale serve --bg 8766` (not Funnel). Re-check with `gbrain mcp expose --status --json`.

### 7.2 Health check

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
curl -sf "http://127.0.0.1:8766/health"
curl -sf "https://<MAC_MAGICDNS>/health"
gbrain mcp expose --status --json
launchctl print "gui/$(id -u)/com.gbrain.serve" | head
```

`/health` 200 = serving. 503 + `Retry-After: 5` = status-only (cannot open the brain); run `gbrain doctor --json` on the Mac (`docs/mcp/DEPLOY.md`). Deep probe: `/health?deep=1`.

From Windows (proves tailnet HTTPS, not loopback):

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_TAILNET_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_TAILNET_HOST>" }; curl.exe -sf "https://<MAC_MAGICDNS>/health" }
```

### 7.3 When mlsfs is down

Live serve **keeps working** (DB and sources are local). Backup copy step fails; keep the local `~/gbrain-backups` copy and retry the copy. Do not block writes on mlsfs.

### 7.4 When Tailscale is down

- Loopback `127.0.0.1:8766` still works → **Hermes (HTTP) still works** if it uses loopback. This is an advantage of not binding only `<MAC_TS_IP>`.
- MagicDNS / Windows relay / Grok Bots **fail**.
- `verify.tailnet` is pending; `verify.local` should stay ok.
- If Tailscale's utun is gone, KeepAlive still serves loopback. Do not bind the 100.x address as the only listener or Hermes dies with the tailnet.
- Funnel is off, so there is no public fallback. That is intended.

### 7.5 When the Mac is asleep or off

Everyone is down. This design requires the Mac mini awake. `docs/guides/remote-mcp.md` offers gbrain.io if no machine stays online; that is not Tailscale-only and is out of scope.

---

## 8. Fork and upstream sync

Verified at `64de25c0`: `master`, `hermes`, and `grok` match each other and upstream.

This design's **only** tree change is `docs/grok/gbrain-shared-brain-design.md`. That is the sync rule:

- Keep all grok-specific writing under `docs/grok/`.
- Additive private config (`~/.gbrain/`, launchd, Tailscale Serve) lives on the Mac, **not** in this public fork.
- Do not edit `src/`, skills, CLI, schema, or other docs "to make the Mac install nicer."
- Do not open a PR to `garrytan/gbrain` for this draft.

Sync procedure for branch `grok`:

On the public fork clone (any machine that holds this git remote — this is not a Mac-mini service command):

```bash
git fetch https://github.com/garrytan/gbrain.git master
git rebase FETCH_HEAD
# if docs/grok/ is the only delta, rebase should be clean
git push --force-with-lease origin grok
```

If that clone *is* the Mac mini, prepend the hostname guard to the block.

Prefer rebase so grok stays a fast-forwardable docs-on-top of upstream master. If a rebase conflict appears outside `docs/grok/`, stop; that means someone committed core edits on grok and this rule was broken.

Install the **upstream stable CLI** on the Mac (`bun install -g github:garrytan/gbrain#stable`), not a random commit of this fork, unless Martin is deliberately running fork builds. The design doc can live on `grok` while the binary tracks stable.

Do not touch branches `master` or `hermes` for this work.

---

## 9. Risks

| Risk | Why it is real | Mitigation |
| --- | --- | --- |
| Grok Bot UX is not standing | Relay needs per-shell approval (task fact). People will want Funnel. | Keep Funnel off until Martin signs the public-HTTPS exception. Do not "just add `--funnel`" in a later hop without updating this draft. |
| Funnel looks private because the hostname is `*.ts.net` | Funnel is **public** (`docs/guides/remote-mcp.md` Security posture). | Treat Funnel as internet exposure + gbrain auth, not Tailscale-only. |
| PGLite single-writer | Hermes stdio recipe starts a second serve and will crash-loop or `live_serve`. | Hermes = HTTP/thin-CLI to the existing serve. Postgres only if that is impossible. |
| Backup vs live serve | `backup create` wants the writer lock; serve holds it. | Stop serve, dump, start serve. Do not dump `brain.pglite` while it is open. |
| Live DB on mlsfs | Lock/WAL on SMB; repair refuses `network_filesystem`. | Local APFS only; mlsfs = copies of archives. |
| Grant URL `http://<MAC_TS_IP>` | `assertSecureEndpoint` throws. | MagicDNS HTTPS for remote clients; loopback HTTP only for Hermes on-box. |
| `--bind 0.0.0.0` muscle memory from pre-v0.34 | Default used to be all interfaces (`src/commands/serve-http.ts`). | Expose's loopback bind; never pass `--bind 0.0.0.0`. |
| Tokens in logs / chat / git | Public fork; Grok transcripts. | 0600 files; `--credentials-out`; no `--log-full-params`; never paste JSON. |
| Two Grok accounts sharing one Windows profile | Either Bot can read the other's credential file. | Separate files, NTFS ACLs if two Windows users; at minimum do not `type` the JSON in a transcript. |
| Status-only looks like "no notes" | `/health` 503, MCP `serve_status_only`. | Agents must read `fix.next` (`docs/protocol/AGENT_OPERATOR_v1.md`). |
| Native Grok MCP plugin | Unverified, release-gated (`docs/guides/grok-bot.md`). | Do not plan on it. Thin CLI on Windows is the path. |
| Embeddings / paid extract left on by accident | Init prints a cost matrix. | `--no-embedding` until Martin opts in. |
| Restore resurrects `forget` | Withdrawal is not physical erasure. | Say so; keep backup ACLs tight. |
| MagicDNS HTTPS not enabled | expose exits 2 `tailscale_https_not_enabled` before publishing. | Enable HTTPS certificates in Tailscale admin DNS. |
| Public repo PII | This file is public. | Placeholders only: `<MAC_TS_IP>`, `<MAC_MAGICDNS>`, `<MAC_LAN_IP>`, `<WINDOWS_TAILNET_HOST>`, `<share>`. No emails, holdings, or real 100.x addresses. |

---

## 10. Open questions (each with a default)

| ID | Question | Default until Martin says otherwise |
| --- | --- | --- |
| Q1 | Bind loopback + Tailscale Serve, or plaintext `<MAC_TS_IP>:8766` like martin-finance-web? | **Loopback + Serve (port 8766).** Literal TS-IP bind waits on a TLS terminator and a grant-URL change. |
| Q2 | Cross-read between personal and business? | **No.** Use `shared`. |
| Q3 | Hermes transport if HTTP MCP is missing? | **Thin CLI over loopback.** Stdio `gbrain serve` only after Postgres, or after stopping HTTP serve. |
| Q4 | Mac mount of mlsfs? | `/Volumes/<share>/personalgrok/gbrain` — confirm with `ls /Volumes` and `mount`. |
| Q5 | Enable Funnel so Grok Bot MCP URL connectors work? | **No.** Breaks Tailscale-only. Revisit only as an explicit exception. |
| Q6 | Engine PGLite vs Postgres on day one? | **PGLite, keyless.** Postgres.app/Docker/Supabase later for concurrency or >1000 files. |
| Q7 | Embeddings on? | **Off** (`--no-embedding`). Voyage if Martin wants semantic search later. |
| Q8 | Windows host name for the relay? | `<WINDOWS_TAILNET_HOST>` until filled. Without it, Grok Bots have no Tailscale-only path. |
| Q9 | Put markdown **source** git repos on mlsfs? | **No.** Local APFS; optional mirror copy. |
| Q10 | `--skills follow` vs `memory-only`? | **`memory-only`.** |
| Q11 | Install gbrain from this fork's `grok` branch or upstream `stable`? | **Upstream stable binary; this fork only holds the design doc.** |
| Q12 | Separate brains instead of sources? | **One brain, four sources.** Separate brains if a future tenant must not share a DB. |

---

## 11. Ordered build plan (coder runs; QA checks)

Martin performs these on the named machines. Agents do not run them from this draft. Every Mac command starts with the hostname guard. Every Windows command is wrapped with the `COMPUTERNAME` check.

### Step 1 — Mac identity and Tailscale (QA: hostname, MagicDNS, **no Funnel**)

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
hostname -s
tailscale status
tailscale serve status
# Funnel must be off. HTTPS certificates must be on (Tailscale admin DNS).
```

QA: hostname is `Martins-Mac-mini`. Node is Running. No Funnel handler on `:443` for this work yet.

### Step 2 — Bun + gbrain (QA: versions)

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version   # >= 1.4.4
bun install -g github:garrytan/gbrain#stable
gbrain --version
```

No Homebrew. No Node. No Python packages. QA: `bun --version` ≥ 1.4.4; `gbrain --version` prints.

### Step 3 — Init keyless PGLite (QA: engine, no embeddings)

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain init --pglite --no-embedding
gbrain doctor --json
```

Relay the search-mode matrix to Martin and record the choice (`INSTALL_FOR_AGENTS.md` Step 3.5). QA: doctor connects; engine is pglite; embedding missing is expected, not a prompt to paste a key.

### Step 4 — Sources (QA: four ids)

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain sources add personal --path "$HOME/gbrain-sources/personal" --name "personalgrok"
gbrain sources add business --path "$HOME/gbrain-sources/business" --name "businessgrok"
gbrain sources add hermes --path "$HOME/gbrain-sources/hermes" --name "hermes"
gbrain sources add shared --path "$HOME/gbrain-sources/shared" --name "shared"
gbrain sources list --json
```

QA: four active sources plus `default`. Paths on local APFS, not `/Volumes/…`.

### Step 5 — Expose tailnet-only on 8766 (QA: loopback + MagicDNS, no Funnel)

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
gbrain mcp expose --port 8766 --no-install --dry-run --json
# Martin reads the plan (effects: persistent_install; egress unless --no-tailscale).
gbrain mcp expose --port 8766 --no-install --yes --json
gbrain mcp expose --status --json
curl -si "http://127.0.0.1:8766/health"
```

QA: receipt mode is tailnet-only, port 8766, engine pglite, service running. `/health` 200 on loopback. `tailscale serve status` proxies `:443` to 8766. **No** `funnel` handler. Admin token file exists, mode 0600, contents never printed.

### Step 6 — Grants (QA: dry-run then real; files 0600)

Run the three `mcp grant … --dry-run --json` commands in §4, then without `--dry-run`.

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
ls -l "$HOME/.gbrain/serve/credentials"
stat -f '%Lp' "$HOME/.gbrain/serve/credentials/"*.json
```

QA: each JSON is 0600; redacted grant receipt shows the intended `--source` and `--federated-read`. No `operator`. No `default` source on the three clients.

### Step 7 — Hermes on loopback (QA: whoami source)

Wire Martin's Hermes to `http://127.0.0.1:8766/mcp` with `hermes.json` (assumption: HTTP or thin CLI). Run `gbrain mcp verify` from the Mac using that credentials file.

QA: verify `server_status: passed`. `whoami` (or verify report) names source `hermes` and federated `hermes,shared`.

### Step 8 — Windows thin CLI (QA: health from Windows, not from the Bot VM)

Install Bun + gbrain **or** copy a compiled `gbrain` onto `<WINDOWS_TAILNET_HOST>`. `gbrain connect https://<MAC_MAGICDNS>/mcp --harness grok-bot --credentials-file <personalgrok.json> --install --root <WINDOWS_GBRAIN_ROOT_PERSONAL>` and the same for businessgrok with its own root **or** its own credentials file in one root (two connects, two names). Prefer two credential files, one launcher each if the adapter allows.

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_TAILNET_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_TAILNET_HOST>" }; curl.exe -sf "https://<MAC_MAGICDNS>/health"; curl.exe -sf --connect-timeout 3 "http://<MAC_LAN_IP>:8766/health"; echo "LAN_EXIT=$LASTEXITCODE" }
```

QA: MagicDNS `/health` succeeds. LAN IP:8766 **fails** (connection refused / timeout). Public IP check in the live acceptance step.

### Step 9 — Backup to mlsfs (QA: checksum pair)

Confirm mount (§6.2). Then the stop-dump-start procedure in §6.3. QA: archive verifies; copy on mlsfs has the same sha256; serve health 200 afterwards.

### Step 10 — LIVE ACCEPTANCE (required)

Service running on the Mac. Each of the three clients writes a **harmless synthetic** note with provenance and `visibility: "world"` only for the test fact (`docs/guides/hosted-harness-access.md` / `docs/guides/remote-mcp.md` verify rules). Use a randomized suffix so the model cannot fake recall. Keep the returned ids. Then read back **through that client's real path**. Then prove isolation. Then prove off-tailnet unreachability. Then withdraw the test facts (`forget`); do not claim erasure from backups.

**10a. Hermes (real path = loopback MCP or thin CLI on the Mac).**

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
# via the Hermes-granted CLI / MCP, not an unscoped local token:
gbrain remember "LIVE-ACCEPT hermes suffix=<RANDOM>" --entity projects/live-accept-hermes \
  --content-origin user_said --provenance "live-accept 2026-11-11" --json
gbrain recall "projects/live-accept-hermes" --json
```

QA: write succeeds; a **separate** recall process returns the exact phrase. Path is `127.0.0.1:8766` or Hermes' MCP tool, not `gbrain` without the hermes grant.

**10b. personalgrok (real path = approved Windows shell → personalgrok launcher).**

On Windows, from a personalgrok-driven shell:

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_TAILNET_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_TAILNET_HOST>" }; & '<WINDOWS_GBRAIN_ROOT_PERSONAL>\bin\gbrain' remember "LIVE-ACCEPT personalgrok suffix=<RANDOM>" --entity projects/live-accept-personalgrok --content-origin user_said --provenance "live-accept 2026-11-11" --json; & '<WINDOWS_GBRAIN_ROOT_PERSONAL>\bin\gbrain' recall "projects/live-accept-personalgrok" --json }
```

QA: phrase comes back from that launcher. A new Grok conversation that only uses this path (not the model's chat memory) can recall it.

**10c. businessgrok (real path = Windows shell → businessgrok launcher).**

Same wrapper, business launcher, entity `projects/live-accept-businessgrok`, different random suffix.

**10d. Separation.**

- personalgrok recall of `projects/live-accept-businessgrok` and `projects/live-accept-hermes` → empty / not found, **not** the other client's text.
- businessgrok recall of personalgrok and hermes test entities → empty / not found.
- Hermes recall of personalgrok and businessgrok test entities → empty / not found.
- Each client **can** write+read a note under `shared` (fourth slug, then forget).

If any client sees another's private test page, **stop** — the grant `--source` / `--federated-read` is wrong. Do not "fix" it by widening tokens.

**10e. Off-tailnet: not reachable.**

From the Mac (LAN IP must not serve gbrain):

```bash
[ "$(hostname -s)" = 'Martins-Mac-mini' ] || { echo "Wrong machine: $(hostname -s)"; exit 1; }
# <MAC_LAN_IP> is the Wi-Fi/Ethernet address, not <MAC_TS_IP> and not 127.0.0.1
curl -sf --connect-timeout 3 "http://<MAC_LAN_IP>:8766/health"; echo "lan8766=$?"
curl -sf --connect-timeout 3 "http://<MAC_LAN_IP>:443/health"; echo "lan443=$?"
curl -sf --connect-timeout 3 "http://0.0.0.0:8766/health"; echo "unspec=$?"
# bind is 127.0.0.1, so LAN must fail. Loopback must still work:
curl -sf "http://127.0.0.1:8766/health"
```

From a phone or laptop **logged out of Tailscale** (or a network off the tailnet):

```text
curl -sf --connect-timeout 5 "https://<MAC_MAGICDNS>/health"
curl -sf --connect-timeout 5 "https://<MAC_MAGICDNS>/mcp"
```

QA: both fail (timeout, NXDOMAIN, or connection refused). If they succeed, Funnel or another public ingress is on — **fail the acceptance** until it is off (`gbrain mcp expose --status` must not report funnel).

From Windows, LAN IP of the Mac:8766 should fail; MagicDNS should succeed (proves "tailnet yes, LAN no"):

```powershell
& { if ($env:COMPUTERNAME -ne '<WINDOWS_TAILNET_HOST>') { throw "Wrong machine: this is $env:COMPUTERNAME, expected <WINDOWS_TAILNET_HOST>" }; curl.exe -sf --connect-timeout 3 "http://<MAC_LAN_IP>:8766/health"; echo "LAN=$LASTEXITCODE"; curl.exe -sf "https://<MAC_MAGICDNS>/health"; echo "TS=$LASTEXITCODE" }
```

**10f. Cleanup.** `forget` each live-accept fact id with reason `live-accept complete`. Recheck active recall is empty. Note that mlsfs backups taken before forget may still contain the phrases.

Acceptance is **pass** only if 10a–10c read back through the real paths, 10d isolation holds, and 10e shows LAN/public closed while tailnet/loopback is open.

---

## Provenance of this draft

| Claim | Status |
| --- | --- |
| Engine split, PGLite path, single-writer, SMB lock refusal, Bun ≥ 1.4.4, expose loopback+Serve, Funnel for cloud agents, grant profiles, `assertSecureEndpoint`, Grok Bot thin-cli, Hermes stdio recipe, backup lock, live_serve exceptions | **Verified** in this repo at `64de25c0` (paths cited above). |
| Two Grok accounts, Windows machine-targeted shell with per-call approval, mlsfs `I:\personalgrok\gbrain\`, Mac mini hostname and Tailscale IP (placeholder), martin-finance-web:8765, Hermes private repo | **Task facts / assumptions.** Hermes HTTP capability is assumed. Windows computer name and Mac SMB volume name are unknown. |
| That Funnel "is still Tailscale-only" | **False** per `docs/guides/remote-mcp.md`. |
| That gbrain uses SQLite | **False.** PGLite is WASM Postgres. |
| Native Grok Bot MCP plugin | **Unverified** upstream; not used here. |

Do not install from this document until Martin reviews the Funnel trade-off (default: off) and fills Q4, Q8, and `<MAC_MAGICDNS>`.
