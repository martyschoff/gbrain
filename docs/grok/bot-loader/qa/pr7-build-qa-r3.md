# gbrain PR #7 build QA, round 3: FAIL

- PR: https://github.com/martyschoff/gbrain/pull/7
- Head checked: 1e96bb8a12b1534a730db192903da9c7d88766f1 (merge of 0124da80 + a67459be on r2 head c0a691bb)
- Reviewer: CloudQA via Cursor cloud agent bc-36049468, model grok-4.6, effort medium (read-only; same model family as the grok-4.7 builder, so not an independent-family check)
- Date: 12 Nov 2026 (ET)
- Result: FAIL, 2 Medium. r2 findings 1-3 are fixed in code and docs; the merge is clean (no duplicate or contradictory paths).

---

Verdict: **FAIL**

`git rev-parse HEAD` = `1e96bb8a12b1534a730db192903da9c7d88766f1`. r2’s three behavioral/doc claims hold in the merge, but HEAD is not clean: `tsc` at the PR #6 heap fails on this PR’s test file, and the claimed re-read-failure → 502 path has no test that fails when it is broken.

## What ran

| Command | Claim | Actual |
|---|---|---|
| `git rev-parse HEAD` | `1e96bb8a12b1534a730db192903da9c7d88766f1` | Match |
| `git fetch origin grok`; `git rev-parse origin/grok` | PR #6 at `3f81d6c5` | `3f81d6c517cd8d80b52f421dceb7836708f9e084` |
| `git diff --stat c0a691bb..HEAD` | r3 delta | 5 files, `374 insertions(+), 8 deletions(-)` |
| `git diff --stat origin/grok...HEAD` | PR vs grok after #6 | 7 files, `1467 insertions(+), 85 deletions(-)` |
| Parents vs merge | `0124da80`, `a67459be` | Merge `1e96bb8a1` = `a67459bee` + `0124da80a` |
| `/tmp` counting mock, token-only, upstream always 401 | 0 `/token`, 1 gate hit, serve 401 body | `tokenCalls` **0**; gate hit **1**; client status **401**; body sha8 `dc930ff5` equals serve; no `upstream_unauthorized` |
| `/tmp` CC grant, always 401 | refresh + one retry | `tokenCalls` **1**, `upstreamHits` **2**, body lens **58/58** both = original MCP bytes, first auth stale / second minted (sha8 only) |
| `/tmp` race: same client / swap / tokenless / delete / symlink / chmod 0 | merge / leave file / pass 401 / 502 | All matched (details in C) |
| 20 parallel held `/token` | 1 `/token` | `tokenCalls` **1**, 20× **200**, one auth sha8 |
| 20 parallel + credential swap during hold | 1 `/token`, waiters consistent | `tokenCalls` **1**, 20× **200**, all auth sha8 = file token, minted not sent, file untouched |
| Always-401 POST `/mcp` | no loop, no secrets | elapsed **3** ms, 1 `/token`, 2 hits, log `POST /mcp client=personal status=401`, no fixture secrets in body/log/stderr |
| SSE quiet 6s | not cut | elapsed **6007** ms, body has `still-open`, status **200** |
| Live `GBRAIN_HOME=/tmp/gbrain-qa-pr7-live-home`, `bun src/cli.ts init --pglite --no-embedding --non-interactive`, `auth register-client … client_secret_post`, `serve --http --bind 127.0.0.1` | gate-shaped `/token` + resolve rewrite | init **0**; register **0**; `/health` **200**; POST `/token` **200**, `expires_in` **3600**, access_token len **74**; resolve `expiresAtDelta` **3600**, `preserved` true, mode **600** |
| Mutations a–h + restore `gate.ts`+`upstream-token.ts` from `c0a691bb` on `/tmp/gbrain-qa-pr7-mut` | each ≥1 fail | **d did not fail** (8/0). a,b,c,e,f,g,h each ≥1 fail. r2 sources: **6 pass / 2 fail** |
| `bun test --timeout 60000 --max-concurrency 1` on 28 non-serial `test/serve-http*.test.ts` + 3 funnel + 2 grok-shared-brain + `client-grants` + `grant-profiles-surface` + `docs-repo-paths` | related suite | **313 pass, 0 fail, 2477 expect(), 36 files, 97.19s, EXIT 0** |
| `node --max-old-space-size=6144 … tsc --noEmit` | typecheck | **OOM**, native abort, file **EXIT 134** (~144s) |
| same tsc `--max-old-space-size=12288` (grok/PR #6 heap; `/tmp` tsbuildinfo) | typecheck after OOM | Completes, **EXIT 2**, 8× `TS2741` in `test/grok-shared-brain-upstream-refresh.test.ts` |

No live token values, client secrets, or non-loopback addresses are printed here (lengths, modes, sha8, counts only). Environment had no `bun`; Bun 1.4.4 was installed to `~/.bun` and `bun install` was run so tests could execute.

## r2 findings status

| r2 | Status | Evidence |
|---|---|---|
| 1 Med — `canRefresh` true for token-only | **Fixed in code** | `gate.ts:399` `canRefresh = authz.refreshable`; `upstream-token.ts:105-108,224-227`. Probe: token-only always-401 → 0 `/token`, 1 upstream, client body = serve `invalid_token`/`serve`. CC still retries once. |
| 2 Med — write captured `doc` after `/token` | **Fixed in code** | `commitMintedToken` `upstream-token.ts:204-221`; swap uses `fromReplacedFile` `231-234`. Probe: same-client merge keeps `profile`/`generation`, mode `600`; swap file untouched, Authorization sha8 = file token not minted; tokenless → `Authorization` empty, serve 401 passed through; delete/symlink/chmod-0 → `{"error":"upstream_token_refresh_failed"}`, 0 upstream hits. |
| 3 Low — empty file documented as 401 | **Fixed** | `docs/grok/tailnet-mcp-access.md:128` vs `upstream-token.ts:249-251`. |

## Merge integrity

Changed vs `c0a691bb`: `docs/grok/bot-loader/qa/pr7-build-qa-r2.md`, `docs/grok/tailnet-mcp-access.md`, `scripts/grok-shared-brain/gate.ts` (1 line: `canRefresh`), `scripts/grok-shared-brain/upstream-token.ts`, `test/grok-shared-brain-upstream-refresh.test.ts`.

Changed vs `origin/grok` (after #6): those plus `docs/grok/bot-loader/qa/pr7-build-qa-r1.md`, `docs/grok/shared-brain/README.md`. This branch does **not** contain PR #6 (`package.json` typecheck heap still **6144**; grok is **12288**).

`0124da80` vs merge: 0124 swallowed a failed re-read and still sent the minted token on credential swap. The merge does **not** keep that. `a67459be` already re-read and used the file token on swap; the merge factors that into `commitMintedToken` + `fromReplacedFile` (`refreshable: false` so a 401 is not retried). One `canRefresh` path, one `commitMintedToken`, no duplicate helpers fighting. 0124’s empty-file 502 test is in HEAD (`test` at line 243). a674’s token-only + clobber coverage is in HEAD (combined test at 348). No contradictory expects.

Residual TOCTOU: after a matching re-read, `writePrivateJsonAtomic` can still rename over a replacement that lands between `readGrant` (`211-215`) and `renameSync` (`64`). No lock/mtime CAS. Window is JSON parse + stringify + `wx` write + two fsyncs + rename (milliseconds). Not treated as a separate defect beyond what r2 asked for (re-read then merge).

## Findings

1. **Medium —** `test/grok-shared-brain-upstream-refresh.test.ts:91,145,214,257,287,330,390,440` (`fetchImpl` mocks). `bun run typecheck` at HEAD OOMs at 6144 (**EXIT 134**). With the grok/PR #6 heap **12288**, tsc finishes and **fails EXIT 2**: `TS2741` `Property 'preconnect' is missing … required in type 'typeof fetch'` on every `fetchImpl` in this PR’s test file (`GateOptions.fetchImpl?: typeof fetch` in `gate.ts:27`). Concrete fix: type the inject as a call signature `(input: RequestInfo \| URL, init?: RequestInit) => Promise<Response>` (or `satisfies` a narrow alias), not `typeof fetch`.

2. **Medium —** `scripts/grok-shared-brain/upstream-token.ts:211-215` (re-read failure → 502). Probe confirms delete/symlink/unreadable after `/token` returns **502** `upstream_token_refresh_failed` and sends no Authorization. Mutation **(d)** (catch returns minted/`mintedFor` instead of throwing) still **8 pass / 0 fail** on `test/grok-shared-brain-upstream-refresh.test.ts`. The r2 rewrite-failure contract is not pinned. Concrete fix: a test that unlinks or `O_NOFOLLOW`-breaks the grant during held `/token` and asserts 502, 0 upstream hits, no minted Authorization.

## Could not check

- Tailscale Serve/Funnel, off-tailnet DNS, `launchctl kickstart` (Linux VM, no `tailscale`)
- Full `gbrain mcp grant --harness grok-bot` (throwaway brain used `auth register-client` + the same `/token` shape)
- Process crash between write and rename (inferred from `wx` + unlink + rename only)
- E2E Postgres `test/e2e/serve-http*.test.ts`
- Production `token_endpoint_auth_method: client_secret_basic` (code path present; grok-bot grants are post; no unit test)
- Hitting the re-read/rename TOCTOU window reliably (code-inspected; 40 parallel writers did not prove a clobber)
