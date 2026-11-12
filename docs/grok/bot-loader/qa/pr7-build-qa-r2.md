# gbrain PR #7 build QA, round 2: FAIL

- PR: https://github.com/martyschoff/gbrain/pull/7
- Head checked: c0a691bb34e29ea18d44844ae5fa9af25b75f0ac (r1 was 96957984; delta 2e4815e6 docs + c0a691bb gate refresh)
- Reviewer: CloudQA via Cursor cloud agent bc-ba499633, model grok-4.6, effort medium (read-only; same model family as the grok-4.7 builder, so not an independent-family check)
- Date: 12 Nov 2026 (ET)
- Result: FAIL, 2 Medium, 1 Low. r1 findings 1-5 are fixed (finding 1 for refreshable client_credentials grant files).

---

Verdict: FAIL

Refresh for grok-bot `client_credentials` grants with `client_id`/`client_secret` matches serve’s `/token` (live loopback exchange 200, `expires_in` 3600, fields preserved, 0600). R1 extras 2–5 in the docs look fixed. The gate still changes r1 behavior for grants that cannot refresh, and an in-flight refresh can overwrite a grant file that was replaced while `/token` was running.

## What ran

| Command | Claim | Actual |
| --- | --- | --- |
| `git rev-parse HEAD` | Head `c0a691bb34e29ea18d44844ae5fa9af25b75f0ac` | Match |
| `git fetch origin grok`; `git diff --stat origin/grok...HEAD` | 6 files, refresh + docs | `6 files changed, 1101 insertions(+), 85 deletions(-)` |
| `git diff --stat 96957984..HEAD` | r1 docs-only → code + doc follow-up | `6 files changed, 892 insertions(+), 100 deletions(-)` |
| Read every changed line | gate, `upstream-token.ts`, tests, three docs | Done |
| Live `gbrain init --pglite --no-embedding --non-interactive` + `auth register-client` + `serve --http` on `127.0.0.1` + gate-shaped POST `/token` | Request shape + `expires_at` | Init 0; register 0; `/health` up; POST `/token` **200**, `expires_in` **3600**, access_token len **74**; `createUpstreamTokens.resolve` wrote `expires_at` ≈ now+3600, extra fields kept, mode **0600** |
| `/tmp` counting mock, 20 parallel near-expiry | One `/token` | `tokenCalls` **1**, 20× HTTP **200** |
| Always-401 upstream + buffered POST `/mcp` | One exchange + one retry | `tokenCalls` **1**, `upstreamHits` **2**, body lens **150/150**, client body serve `invalid_token` |
| `bun test --timeout 60000 --max-concurrency 1` on 28 non-serial `test/serve-http*.test.ts` + 3 funnel + 2 grok-shared-brain + `client-grants` + `grant-profiles-surface` + `docs-repo-paths` | 308/0/35 (builder, no docs-paths) | **310 pass, 0 fail, 2445 expect(), 36 files, 86.05s, exit 0** |
| `bun run typecheck` (heap 6144 in `package.json`) | Typecheck | HEAD **OOM** (script exit **134**). `origin/grok` archive, same script: **OOM** too |
| `/tmp` mutations a–f + r1 gate revert | Each must fail ≥1 test | Each **4 pass / 1 fail** except r1 **1 pass / 4 fail** |

No live token values, client secrets, or non-loopback addresses are printed here (lengths, modes, hashes only).

## r1 findings status

| r1 | Status | Evidence |
| --- | --- | --- |
| 1 High — gate never refreshes CC `access_token` | **Fixed for refreshable grok-bot grant files** | `upstream-token.ts:40-43,202-210`; live `/token` 200; HEAD tests 5/5 on `grok-shared-brain-upstream-refresh.test.ts` when `.git` is present |
| 2 High — extra-bot never grants / `upstream_token_file` | **Docs fixed** | `docs/grok/tailnet-mcp-access.md:164-195`: loopback `gbrain mcp grant`, absolute `upstream_token_file`, `launchctl kickstart`. Flags exist (`mcp.ts:16,39-41`, help probe: `--token-ttl`, `--credentials-out`, `--admin-token-file`, `--url`, `--harness`) |
| 3 Med — Accept includes SSE vs JSON expectation | **Docs fixed** | curlrc `Accept: application/json` (`223-230`); SSE described as `event: message` + `data:` (`14,263`) |
| 4 Med — wrong issuer/resource story | **Docs fixed** | CC `resource` unset (`oauth-grants.ts:337`); verifier only if `auth.resource` (`serve-http.ts:790-798`); `--url` loopback because MagicDNS is the gate (`116,124`) |
| 5 Low — wrong-bearer on argv | **Docs fixed** | `--config` 0600 dummy (`233-251`) |

## 1. Diff

`origin/grok...HEAD` is exactly:

- `scripts/grok-shared-brain/upstream-token.ts` (new, 220)
- `scripts/grok-shared-brain/gate.ts` (+164 / −84 vs r1 handler)
- `test/grok-shared-brain-upstream-refresh.test.ts` (new, 284)
- `docs/grok/tailnet-mcp-access.md` (300)
- `docs/grok/shared-brain/README.md` (1 sentence)
- `docs/grok/bot-loader/qa/pr7-build-qa-r1.md` (r1 record)

`96957984..HEAD` is `2e4815e6` (docs 2–5) + `c0a691bb` (refresh). No other runtime files.

## 2. Refresh correctness

Serve `POST /token` (`serve-http-oauth.ts:432-450`) accepts `grant_type=client_credentials` with **either** `client_secret_post` (body `client_id` + `client_secret`) **or** HTTP Basic. It does **not** require `scope`/`resource` for CC. `mcp grant` registers `tokenEndpointAuthMethod: 'client_secret_post'` and does not write that field on the handoff (`mcp-provision.ts:108-123`). Gate default is post (`upstream-token.ts:149-151`).

Live (throwaway PGLite, `auth register-client` CC + `client_secret_post`, not a full `mcp grant`):

- Gate-shaped POST: status **200**, `token_type` bearer, `expires_in` **3600**, token length **74**
- Basic on that same post-registered client: also **200** (serve does not bind method)
- `createUpstreamTokens.resolve` on an expired grant: header scheme Bearer, extra field `preserved`, `profile` kept, `expiresAtDelta` **3600**, mode **0600**
- `expires_at` from mock `expires_in: 77`: **1700000077** = `NOW_SEC + 77` (`upstream-token.ts:183-186`)

Omitted `expires_in` → `DEFAULT_ACCESS_TTL_SECONDS` 3600 (`18-19,183-185`). Other grant keys are spread (`186`).

## 3. Races

| Probe | Result |
| --- | --- |
| 20 parallel at expiry, held `/token` | **1** `/token`; 20× **200** |
| Two grant paths, held `/token` | **1** call per file (`a:1,b:1`) |
| First `/token` 500, second 200 | First **502** `{"error":"upstream_token_refresh_failed"}`; second **200**; `tokenCalls` **2** (map cleared in `finally`, `136-137`) |
| Replace file while refresh in flight | Mid-read had the replacement; after resolve the file was the **old** `doc` + minted token (`overwroteReplacement: true`) |
| Inflight map | Per `createUpstreamTokens()` instance, not process-wide; deleted in `finally` |

## 4. Retry / body / SSE

`readBody` buffers before proxy (`gate.ts:366`). Retry uses the same `Buffer` (`400-413`). Always-401: **1** exchange + **2** upstream POSTs, body length **150** both times (original 150). Second `proxy` has no `holdStatus`, so it cannot loop.

SSE: existing test still passed (`an SSE body that stays quiet past the upstream timeout is not cut`, 6008 ms). Extra probe: `/mcp` POST, `content-type` `text/event-stream`, `event: message` + `data:`, elapsed **1205** ms (not cut by the 5s header timer).

## 5. Secrets

No `console.log` of grant material. `finish` goes through `redactSecrets` (`gate.ts:334-337`, `tokens.ts:65-71`). Error bodies are `{ error: <code> }` only (`381-389`). `UpstreamTokenError` message is the code string (`upstream-token.ts:22-30`). Fetch failures are swallowed (`162-163`). Failure probe: response/logs did not contain fixture secrets. Experiment stderr length **0**. Tests never put a bearer on argv (HTTP `headers.authorization`).

Exact bodies seen: `{"error":"upstream_unauthorized"}`, `{"error":"upstream_token_refresh_failed"}`, `{"error":"bad_gateway"}`.

## 6. File safety

`openSync(temporary, 'wx', 0o600)` then `fchmod` **before** write, `fsync`, `rename`, `fsyncDirectory` (`45-67`). After rename, mode **0600** (atomic test + live write + `umask 0` write still **600**). Same directory. Failure unlinks the temp (`55-57,63-65`). Symlink grant: `O_NOFOLLOW` read → **502** `bad_gateway`, **0** `/token` (`74-77`). Crash after write/before rename leaves a `.upstream-token.*.tmp` and the old grant; not crash-injected here.

## 7. Non-refreshable / r1 forwarding

| Case | `/token` | Upstream `Authorization` | Client |
| --- | --- | --- | --- |
| personal/business/hermes, **no** `upstream_token_file` | **0** | header length **0** | **200** |
| Token-only JSON `{access_token}` (r1 test shape), serve **200** | 0 | Bearer grant | 200 (`grok-shared-brain.test.ts:746-771`, HEAD pass) |
| Token-only, serve **401** | **0** | 1 hit | Gate **`{"error":"upstream_unauthorized"}`**, not serve’s `invalid_token` |

`canRefresh` is `authz.secret !== null && upstream_token_file` (`399`). `secret` is the access token, so a file that cannot call `/token` still **holds** the 401 and then `exchangeOnce` 401s (`146-147,212-217`). r1 forwarded serve’s 401 (`96957984` `gate.ts` proxy once).

## 8. Mutations (`/tmp/gbrain-qa-r2`, dummy `.git`, `test/grok-shared-brain-upstream-refresh.test.ts` only)

| Mut | Change | Result | Failed test |
| --- | --- | --- | --- |
| a | Margin ignored (`expiresAt <= now` only) | 4 pass / **1 fail** | refreshes before expires_at… |
| b | No 401 hold/retry | 4 / **1** | retries one upstream 401… |
| c | `for (;;)` on held 401 | 4 / **1** (30.00s) | retries one upstream 401… |
| d | No inflight map | 4 / **1** | concurrent requests share one… |
| e | `writeFileSync` mode **0644** | 4 / **1** | rewrites the grant file atomically… |
| f | Error JSON includes `access_token` | 4 / **1** | a failed refresh is 502 or 401… |
| r1 | `gate.ts` restored from `96957984`; `upstream-token.ts` kept so the test file still imports | **1 pass / 4 fail** | all except the direct `writePrivateJsonAtomic` test |

HEAD of that file in the real repo: **5 pass / 0 fail**.

## 9. Related tests / typecheck

HEAD (repo with `.git`): **310 / 0 / 2445 / 36 files / exit 0**. Builder 308/0/35 omitted `test/docs-repo-paths.test.ts` (2 tests).

`bun run typecheck`: HEAD OOM at 6144 MB, exit **134**. `origin/grok` tree, same script: OOM as well (pre-existing; this PR is not a typecheck delta you can see).

## 10. Docs

r1 2–5 addressed (section above). Refresh: 60s margin, one in-flight per file, 0600 fsync/rename, one 401 retry, `401` / `502` codes (`126-128`). README (`106`) says the gate refreshes; Funnel remains off in this note (`4,48-56,280`). Recovery Python prints `rewrote grant file` only. Curl secrets via 0600 `--config`.

Doc/code mismatch: line 126 says missing token without `client_id`/`client_secret` is `401` `upstream_unauthorized`. Empty `{}` hits `207-210` → **502** `bad_gateway`. Expired/missing token **with** `expires_at` and no secrets → **401** via `exchangeOnce`.

## 11. Privacy

Changed lines: placeholders `<MAC-HOST>`, `<TAILNET>.ts.net`, `<BOT-DEVICE>`, `<TOKEN>`, `<PRIVATE-PATH>`; addresses `127.0.0.1` and `100.64.0.0/10` only. Fixture strings in tests are labeled `do-not-log`. r1 QA file has no emails, home usernames, or token literals (prefix `gbft_` mentioned as generator). README still uses `$HOME/personalgrok/gbrain` (layout name, already on `grok`).

## Findings

1. **Medium —** `scripts/grok-shared-brain/gate.ts:399-413` with `upstream-token.ts:146-147,212-217`. A grant file that has an `access_token` but no `client_id`/`client_secret` (r1 forwarding shape; also any non-CC file that cannot mint) still sets `canRefresh`. On upstream 401 the gate holds the body, skips `/token`, and returns `{"error":"upstream_unauthorized"}` instead of serve’s 401. **Fix:** set `canRefresh` only when `hasClientCredentials(doc)` (or equivalent); if refresh is impossible, proxy once as r1 did.

2. **Medium —** `scripts/grok-shared-brain/upstream-token.ts:133-140,143-188`. Single-flight captures `doc` at start and `writePrivateJsonAtomic(path, { ...doc, access_token, expires_at })` at end. An external replace during `/token` is overwritten with the stale client (`overwroteReplacement: true` in the /tmp probe). **Fix:** re-read after the response (or take a file lock / compare mtime) and merge only `access_token`/`expires_at` into the latest JSON, or refuse the write if the file changed.

3. **Low —** `docs/grok/tailnet-mcp-access.md:126` vs `upstream-token.ts:207-210`. Docs say missing token without secrets is `401` `upstream_unauthorized`. A file with neither `access_token` nor `expires_at` nor secrets is **502** `bad_gateway`. **Fix:** document the empty/unreadable path as `bad_gateway`, and `upstream_unauthorized` only when exchange is attempted and refused.

## Could not check

- Tailscale Serve/Funnel, off-tailnet DNS, `launchctl kickstart` (Linux QA host, no `tailscale`)
- Full `gbrain mcp grant --harness grok-bot` against that live serve (no admin-token handoff in the throwaway brain; `/token` was proven with `auth register-client` + the same gate client)
- Process crash mid-rename (inferred from `wx` + unlink + rename only)
- E2E Postgres `test/e2e/serve-http*.test.ts`
- Production grant JSON `token_endpoint_auth_method: client_secret_basic` (code path present; grok-bot grants are post; no unit test for Basic)
