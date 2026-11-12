# gbrain PR #7 build QA r1 — FAIL (2 High, 2 Medium, 1 Low)

- PR: https://github.com/martyschoff/gbrain/pull/7
- Head checked: 96957984926d18053a8491c911d63a958b3550cd (docs only: docs/grok/tailnet-mcp-access.md, 224 lines)
- Reviewer: CloudQA via Cursor cloud agent bc-fdd15a44, model grok-4.6 (effort medium). Same model family as the builder (grok-4.7); Claude launches need credits.
- The transport, gate, Host-rewrite, bearer and Funnel-off claims all match the code. Loopback gate checks returned 401/401/200/200, and the related tests are 260/0.
- Blocking: (1) the gate never refreshes the grant access_token (grok-bot TTL is 3600 s), so a "standing" connector dies after about an hour; (2) the extra-bot steps never create a grant or set upstream_token_file. Also the Accept/SSE checklist mismatch, a wrong issuer/resource explanation, and a dummy bearer passed on the command line.
- CloudQA note: finding 1 is better fixed in the gate (refresh through client_credentials before expiry, or retry once on an upstream 401) than only documented. It is the likely cause of the 401 in the gbrain live r1 step 6.

---

Verdict: FAIL

Docs-only PR against `origin/grok`: exactly `docs/grok/tailnet-mcp-access.md` (224 lines). Core transport/gate facts match HEAD. It still documents a standing Grok Bot connector without a working upstream-token lifetime, and the extra-bot path never wires a grant file. That is enough to fail.

## What ran

| Command | Claim | Actual |
| --- | --- | --- |
| `git rev-parse HEAD` | Review HEAD `96957984926d18053a8491c911d63a958b3550cd` | Match |
| `git fetch origin grok` then `git diff --stat origin/grok...HEAD` | Docs only, that file | `docs/grok/tailnet-mcp-access.md \| 224 +` ; one file; 224 insertions |
| `wc -l docs/grok/tailnet-mcp-access.md` | 224 lines | `224` |
| Read cited HEAD sources | Endpoint/gate/token/Host claims | Match (table below) |
| Context.dev scrape of Tailscale CLI Serve/Funnel docs | `--bg 8767` and Funnel-off syntax | Port target + `--bg` + default HTTPS 443 + `http://127.0.0.1` proxy; `funnel --https=443 --set-path=/ off`; `funnel status` |
| `/tmp/gbrain-qa-gate-check.mjs` (gate on `127.0.0.1:8767`, mock upstream, throwaway hashes/grant, curl `--config`) | Checklist status codes | health/GET `/mcp` no bearer: **401**; wrong bearer: **401**; initialize POST: **200** bodyLen **139**; tools/list POST: **200** bodyLen **63**; MagicDNS `Host`/`Origin`: **200**; token file and curlrc mode **0600** (`384`); upstream `Host` loopback; Origin not forwarded; Authorization was grant access_token, not `gbft_` |
| One-shot gate curl of 401 bodies | Body `{"error":"unauthorized"}` | Body was exactly that JSON, then HTTP 401 |
| `bun test --timeout 60000 --max-concurrency 1` on 28 non-serial `test/serve-http*.test.ts` + `test/funnel.test.ts` + `test/funnel-cli.test.ts` + `test/funnel-ops.test.ts` + `test/grok-shared-brain.test.ts` + `test/docs-repo-paths.test.ts` | Related tests on HEAD | **260 pass, 0 fail**, 2196 `expect()`, 33 files, ~82s, exit 0. Docs-path test: 2 pass. No code change, so this is not a behavior regression. |
| Real `gbrain serve` + `gbrain mcp grant` + Tailscale + off-tailnet DNS | Full stack / Funnel-off / expiry after 3600s | Not run (no Tailscale; no throwaway brain serve) |

No token values, grant secrets, real hostnames, or non-loopback addresses are printed here.

## Claims vs HEAD

| Claim | file:line | Verified |
| --- | --- | --- |
| `POST /mcp`; GET `/mcp` 405 `Allow: POST, DELETE`; stateless `StreamableHTTPServerTransport` | `src/commands/serve-http-mcp.ts:133-155`, transport `708-712` | **Yes.** GET handler `139-142`; POST `153-155`; `sessionIdGenerator: undefined` at `708`. |
| Gate treats `/mcp` and `/mcp/` as MCP | `scripts/grok-shared-brain/mcp-policy.ts:26-29` | **Yes.** `path === '/mcp' \|\| path.startsWith('/mcp/')`. |
| `tailscale serve --bg 8767`: HTTPS 443 → gate `127.0.0.1:8767` → serve `127.0.0.1:8766` | `src/core/tailscale.ts:28`, `tailscaleServeArgv` `207-208`; `scripts/grok-shared-brain/funnel-policy.ts:10-11`; plist `--upstream http://127.0.0.1:8766` `--port 8767`; `src/commands/serve-http.ts:622`; `listenGate` binds `127.0.0.1` (`gate.ts:340-344`) | **Yes** in this repo. Tailscale docs: default `--https`, target may be a port, proxies only `http://127.0.0.1`. |
| Bearer `Authorization: Bearer`; miss/wrong → 401 every route including `/health`; hashes 0600 | `tokens.ts:248-264`; `gate.ts:271-282`; `writeTokenFile` `201-228` | **Yes.** Confirmed on loopback: `/health` and `/mcp` 401. |
| Gate ignores `Host`/`Origin`, rewrites `Host` to loopback | `gate.ts:134-142`, `169` | **Yes.** Forwarded set has neither; `headers.host = upstream.host`. Loopback Host seen on mock upstream when curl sent a MagicDNS Host. |
| Valid gate bearer can still fail at serve if grant resource URL ≠ serve issuer | `serve-http.ts:650-672,790-798`; `oauth-grants.ts:41-54,332-337`; `mcp-provision.ts:118-121` | **No for this grant type.** `grok-bot` grants are `client_credentials`; `clientCredentials` issues `resource: undefined`. Verifier only canonicalizes when `auth.resource` is set. JSON-RPC auth failure after a good gate bearer is expiry/invalid access_token, not MagicDNS vs loopback audience. |

## 1. Diff and the doc

`origin/grok...HEAD` is docs-only: that one file, 224 lines. Read in full. Placeholders only. Architecture (gate on 8767, serve on 8766, Funnel off, per-bot gate bearer) matches the code.

## 2. Tailscale: tailnet-only

Operator commands are Serve, Funnel **off**, or `funnel status`. No `tailscale funnel --bg`, no `--funnel`, no bind of gate/serve off loopback.

- `tailscale funnel --https=443 --set-path=/ off` matches current Funnel “turn off” syntax and `tailscaleServeOffArgv` (`src/core/tailscale.ts:212-213`).
- `tailscale serve --bg 8767` is the form this repo publishes (`tailscale.ts:28,207-208`). Current Tailscale Serve docs: `--bg`, default HTTPS, port target → `http://127.0.0.1:<port>`.
- Funnel-off checks: `serve status` / `--json`, `AllowFunnel` true = Funnel on (`parseServeStatusStrict` `446-447`), `funnel status` is a real subcommand. Human `(tailnet only)` is the Serve status phrasing.
- Pre-off if Funnel already on: `mcp-expose.ts:841-845` (`serve --bg` over a Funnel mount keeps Funnel). Doc is right to off Funnel first.

## 3. Token mint / register / revoke

| Doc command | Exists? | Token exposure |
| --- | --- | --- |
| `cli-generate-tokens.ts --out … [--force]` | Yes (`--out`, `--force`) | Plaintext **once on stdout**; hashes 0600. Redirect to 0600 file is correct. Do not omit the redirect. |
| `cli-set-upstream-tokens.ts --tokens --grants` | Yes | Does not read/print grants; only `personal`/`business`/`hermes`. |
| Extra-bot `python3 -c` + env `F`/`H` | Not a repo CLI; crypto matches `FUNNEL_TOKEN_PREFIX` + 32 bytes | Secret not in argv; files `chmod 0600`. |
| `launchctl kickstart -k gui/$(id -u)/com.gbrain.funnel-gate` | Plist label matches | Reload required: `cli-gate.ts` reads the file at start. |
| `gbrain mcp admin revoke CLIENT_ID --url … --admin-token-file … --json` then `--yes --if-version` | Yes (`mcp-admin.ts:19,75,95,112-114`) | Admin token via file, not argv. |

Flag: verification still puts a dummy bearer on argv (`Authorization: Bearer wrong-token`). The good path uses `--config`.

**Extra-bot gap:** adding a client object does not set `upstream_token_file`. Without it, `upstreamAuthorization` returns a null header (`gate.ts:118-119`) and the proxy omits `Authorization` (`168`). Serve’s `/mcp` then 401s. `cli-set-upstream-tokens` will not fill that in.

## 4. Upstream token lifetime (this is the standing-path break)

- `gbrain mcp grant` uses OAuth `client_credentials` (`mcp-provision.ts:108-121`).
- `expires_at = now + (expires_in ?? tokenTtl ?? 3600)`.
- `grok-bot` is `renewable: true` (`registry.ts:40`) → profile TTL **3600s** (`profiles.ts:9,75`).
- Gate reads `access_token` from `upstream_token_file` **every request** and **does not refresh** (`gate.ts:118-126`). No refresh in `scripts/grok-shared-brain/`.
- Updating an existing grant keeps credentials (`mcp-provision.ts:97-100`). That does not mint a new access_token.
- `--token-ttl` is a real `mcp grant` flag (`mcp.ts:39,82`) and lands on the client via the grant patch; the gate still never refreshes.

Doc line 207 says the grant can expire and the gate does not refresh. It does **not** say default **3600s**, `mcp grant --token-ttl`, serve `--token-ttl`, client_credentials re-exchange into the grant file, or that a re-grant of an existing client will not rotate `access_token`. A “standing path” connector dies about an hour after grant.

## 5. Verification checklist

Loopback gate (mock serve) matched the **HTTP codes** in the doc: 401 / 401 / 200 / 200; `/health` without bearer 401.

Problems in the **written** checklist:

- `Accept: application/json, text/event-stream` is required by several serve tests, but the same doc says POST may be **SSE**. Expecting a raw JSON-RPC object can fail against real `StreamableHTTPServerTransport`.
- Unauth/wrong-token curls are **GET**; gate still 401s (auth runs first). Fine for 401, not a POST `/mcp` probe.
- Off-tailnet: “fail before HTTP (DNS or connect); 200 or 401 means Funnel” is the right idea. Not executed here.

## 6. Issuer / resource URL

Serve issuer: `publicUrl || http://localhost:${port}` (`serve-http.ts:650`); `mcpResourceUrl = /mcp` on that origin (`672`). `--public-url` is the flag. Canonicalization is origin+path (`oauth-grants.ts:41-54`), **not** `Host`. `127.0.0.1` and `localhost` are different origins.

For **this** connector, CC tokens are not resource-bound (`oauth-grants.ts:337`; skip at `serve-http.ts:793`). Grant `--url http://127.0.0.1:8766/mcp` is still required so grant/admin HTTP hits serve, not the gate (`admin_forbidden`, `mcp-policy.ts:123-124`). Pointing `--url` at MagicDNS after Serve publishes 443→8767 will not fix an expired access_token. The doc never names `--public-url` or that CC audience is skipped.

## 7. Tests

HEAD, docs-only, so runtime cannot regress from this diff.

| Suite | Result |
| --- | --- |
| 28 non-serial `serve-http*.test.ts` + 3 funnel + `grok-shared-brain` + `docs-repo-paths` | 260 pass / 0 fail / 33 files |
| `test/docs-repo-paths.test.ts` | Pass; new doc’s `scripts/grok-shared-brain/*.ts` paths exist |
| E2E serve / Postgres | Not run |

PR body (258/32) matches this run minus `docs-repo-paths` (2 tests).

## 8. Privacy

Placeholders (`<MAC-HOST>`, `<TAILNET>.ts.net`, `<BOT-DEVICE>`, `<TOKEN>`, `<PRIVATE-PATH>`). Addresses: `127.0.0.1` and `100.64.0.0/10` only. `gbft_` only as a generator prefix. No emails, home paths, or token-looking literals.

## Findings

1. **High —** `docs/grok/tailnet-mcp-access.md:3,77,207` (also grant steps at `107-115`). Standing connector without upstream refresh. Gate never refreshes `access_token`; grok-bot TTL is 3600s. After ~1 hour, gate bearer still 401s at serve. **Fix:** State default 3600s and `grok-bot` renewable TTL. Document that the gate will not refresh. Give a file-based re-issue: `gbrain mcp grant … --token-ttl <n>` on **create**, or `/token` client_credentials using the grant file’s `client_id`/`client_secret` written to a new 0600 grant JSON (never argv), then leave `upstream_token_file` pointed at it. Do not imply re-running grant on an existing `--client` refreshes the access_token. Optional: cron/launchd to rewrite the grant file.

2. **High —** `docs/grok/tailnet-mcp-access.md:117-131`. Extra bot never gets `upstream_token_file` or `gbrain mcp grant`. **Fix:** After minting the hash, issue a loopback grant to a 0600 JSON and set that client’s `upstream_token_file` to the absolute path (parser already requires an absolute path, `tokens.ts:129`). Restart the gate. `cli-set-upstream-tokens.ts` only updates the three built-in ids.

3. **Medium —** `docs/grok/tailnet-mcp-access.md:14,157-186`. Checklist Accept includes `text/event-stream` while expecting a JSON-RPC object; line 14 says that Accept can yield SSE. **Fix:** For curl, use `Accept: application/json` only, or document SSE (`event: message` / `data: {jsonrpc…}`) as success.

4. **Medium —** `docs/grok/tailnet-mcp-access.md:115,199`. Resource/issuer mismatch is the wrong explanation for grok-bot CC grants (`resource` unset). Loopback `--url` is so grant/admin does not hit the gate. **Fix:** Say: (a) grant/admin `--url` must be `http://127.0.0.1:8766/mcp` because MagicDNS is the gate; (b) CC access_tokens are not audience-bound; (c) JSON-RPC auth errors after a good gate bearer are almost always expired/missing `access_token`; (d) serve issuer is `--public-url` or `http://localhost:<port>` (`serve-http.ts:650`), which is independent of Tailscale Host.

5. **Low —** `docs/grok/tailnet-mcp-access.md:175-177`. Wrong-bearer check puts a bearer on argv/`ps`. **Fix:** `--config` a 0600 file whose header is `Authorization: Bearer wrong-token`.

## Could not check

- Live Tailscale Serve/Funnel on this VM (no `tailscale` binary); syntax checked against Tailscale CLI docs + `src/core/tailscale.ts`.
- Off-tailnet DNS/connect failure.
- Real `gbrain serve --http` + `gbrain mcp grant` + initialize/`tools/list` through `StreamableHTTPServerTransport` (SSE vs JSON, MCP-Protocol-Version). Loopback used a mock upstream that always returned JSON 200 after swapping in the grant access_token.
- Access_token expiry after 3600s on a live oauth_tokens row (code-traced only).
- `launchctl kickstart` (Linux QA host).
- E2E/Postgres serve tests.
