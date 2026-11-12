# Tailnet MCP access for Grok Bots

**Say to your agent:** *"Point the Mac's tailnet-only HTTPS name at the loopback gate on 127.0.0.1:8767, keep Tailscale Funnel off, and connect each Grok Bot to https://<MAC-HOST>.<TAILNET>.ts.net/mcp with its own bearer."*

This note is the standing path for Grok Bot devices that are already on the same tailnet and reach the Mac by MagicDNS. It does not turn Funnel on. It does not change `gbrain serve`. Placeholders only: `<MAC-HOST>`, `<TAILNET>.ts.net`, `<BOT-DEVICE>`, `<TOKEN>`, `<PRIVATE-PATH>`. Do not commit a real hostname, tailnet name, address, email, username, token, or home path. `127.0.0.1` and the range `100.64.0.0/10` are the only addresses this note uses. Bots use the MagicDNS name, not an address in `100.64.0.0/10`.

## What the code already does

The gate does not allow or reject a request based on the `Host` or `Origin` the bot sends, and it does not read Tailscale identity headers. It refreshes each bot's upstream access token itself. That refresh is the normal path under [Upstream access token lifetime](#upstream-access-token-lifetime).

| Fact | Where |
| --- | --- |
| MCP path is `/mcp` (also `/mcp/` on the gate) | `scripts/grok-shared-brain/mcp-policy.ts` `routeClass` (lines 26–29); serve mounts `POST /mcp` in `src/commands/serve-http-mcp.ts` (line 153) and documents that path in `src/commands/serve-http.ts` (line 7) |
| Transport is stateless streamable HTTP | `src/commands/serve-http-mcp.ts` (lines 133–141 and 708). `GET /mcp` returns 405 with `Allow: POST, DELETE` because there is no server-initiated SSE backchannel. `POST /mcp` uses `StreamableHTTPServerTransport` with no session id. This is not the legacy SSE transport. A curl check sends `Accept: application/json` and expects a JSON-RPC object. Sending `Accept: application/json, text/event-stream` can make that same POST succeed as SSE (`event: message` and a `data:` line that holds the JSON-RPC object). |
| `tailscale serve` must proxy to the gate, `127.0.0.1:8767` | `scripts/grok-shared-brain/funnel-policy.ts` `GATE_PORT` (line 10) and `GBRAIN_SERVE_PORT` (line 11). The LaunchAgent listens on 8767 and sets `--upstream http://127.0.0.1:8766` (`scripts/grok-shared-brain/launchd/com.gbrain.funnel-gate.plist`). `gbrain serve` binds `127.0.0.1` by default (`src/commands/serve-http.ts` line 622) on 8766. |
| Bearer is `Authorization: Bearer <token>` | `scripts/grok-shared-brain/tokens.ts` `bearerToken` (lines 248–252) and `authenticate` (lines 256–264). The gate calls that on every route, including `/health` and `/mcp` (`scripts/grok-shared-brain/gate.ts` lines 331–342). A missing header, a non-Bearer scheme, or a bearer that matches no client hash is `401` with `{"error":"unauthorized"}`. |
| Storage is hashes outside the repo | `~/.gbrain/serve/funnel-tokens.json` (`tokens.ts` `defaultFunnelTokenPath`, lines 49–50), mode 0600, SHA-256 only. Plaintext is not written to that file. The on-disk path is `<PRIVATE-PATH>/.gbrain/serve/funnel-tokens.json`. |
| `Host` and `Origin` are not an allowlist | `gate.ts` `handle` never reads `Host` or `Origin`. `proxy` copies only `content-type`, `accept`, `accept-encoding`, `user-agent`, `mcp-session-id`, `mcp-protocol-version`, and `last-event-id` (lines 125–133), then sets `Host` to the upstream loopback host (line 173). The MagicDNS name is not forwarded to serve. Serve has no Host allowlist. CORS on `/mcp` (`src/commands/serve-http-oauth.ts`) applies when a browser sends `Origin`; the gate drops `Origin`, so serve does not see the MagicDNS origin. |
| Tailscale identity is not authentication | Nothing in `scripts/grok-shared-brain/gate.ts` or `tokens.ts` reads `Tailscale-User-Login` or any other Tailscale identity header. The gate does not need those headers. Tailnet membership only decides who can open the HTTPS name. The bearer is still required. |

`funnel_enabled` in the token file is stored and logged. The request handler does not consult it. Funnel off is a Tailscale setting, not a flag the gate enforces.

After a valid bearer, the gate may still refuse the call before it proxies: unknown route `403` `wrong_scope`, `/admin` and the other admin paths `403` `admin_forbidden` (`mcp-policy.ts` lines 30–36 and 123–127), a write to `shared` `403` `shared_write_forbidden`, and over the per-client limit `429`. A proxied call uses the client's `upstream_token_file` grant (`scripts/grok-shared-brain/upstream-token.ts` `resolve`). That file is a separate secret from the bot bearer. If it is missing or unreadable, the gate returns `502` `bad_gateway` and does not log the grant. When the access token is missing or inside 60 seconds of `expires_at`, and the file has `client_id` and `client_secret`, the gate exchanges `client_credentials` at the loopback upstream's `/token` and rewrites the file before it proxies.

## Architecture

```
<BOT-DEVICE>  (tailnet member, MagicDNS)
    |  HTTPS  https://<MAC-HOST>.<TAILNET>.ts.net/mcp
    |  Authorization: Bearer <TOKEN>
    v
tailscale serve on the Mac   tailnet-only, Funnel off, TCP 443
    |  HTTP  http://127.0.0.1:8767/<same path>
    v
funnel gate   launchd label com.gbrain.funnel-gate
    |  checks the bearer, then HTTP http://127.0.0.1:8766/<same path>
    |  Host rewritten to the loopback upstream
    |  Authorization replaced with the grant file's access_token
    |  near expiry, POST /token on 127.0.0.1:8766, then rewrite that grant file
    v
gbrain serve  127.0.0.1:8766   POST /mcp
```

Port 8766 stays on loopback for the host CLI and for grant issuance. It is not the Tailscale proxy target. `/health` on 8766 does not require a bearer, and `/admin` is on that same listener. Publishing 8766 would put those routes on the tailnet.

## Tailscale serve (operator, on the Mac)

Run this in person. The repo scripts do not run it. This is tailnet serve, not Funnel. Do not run `tailscale funnel`.

If `tailscale serve status` already shows a Funnel mount (`AllowFunnel` true for this host on 443), turn that mount off before publishing. `tailscale serve --bg` on top of a Funnel mount keeps Funnel on (`src/commands/mcp-expose.ts` lines 841–845).

```bash
tailscale funnel --https=443 --set-path=/ off
tailscale serve --https=443 --set-path=/ off
tailscale serve --bg 8767
```

`tailscale serve --bg 8767` is the publish form this repo encodes (`src/core/tailscale.ts`): HTTPS on 443, tailnet-only, proxying to `http://127.0.0.1:8767`. Do not pass `8766`. Do not pass `--funnel`. Do not run `tailscale serve reset` (that clears every handler on the node).

A foreground `tailscale serve` in another terminal owns `:443` until that terminal stops it. `--bg` does not overwrite a foreground session.

### Check that Funnel is off and the target is the gate

```bash
tailscale serve status
tailscale serve status --json
```

Confirm all of these:

- The human status says tailnet only.
- The JSON `Web` handler for `<MAC-HOST>.<TAILNET>.ts.net:443` has path `/` and `Proxy` `http://127.0.0.1:8767`.
- `AllowFunnel` is absent, or it has no `true` value. `parseServeStatusStrict` in `src/core/tailscale.ts` (lines 446–447) treats a value of `true` as Funnel on.
- `tailscale funnel status` shows no public mount.

`https://<MAC-HOST>.<TAILNET>.ts.net/mcp` is the connector URL. The gate keeps the path (`gate.ts` `proxy`, line 209). Do not register the bare origin.

## Per-bot connector

Each bot gets its own gate bearer. The connector secret is the header:

```
Authorization: Bearer <TOKEN>
```

Store `<TOKEN>` in the bot's connector secret. Do not put it in the repo, a chat, a shell history, or a log. Do not run the checks below under `set -x`.

Registered client ids in a generated file are `personal`, `business`, and `hermes`. Each may call `health` and `mcp`. Each writes only its own source and reads that source plus `shared` (`tokens.ts` lines 43–47). The parser also accepts extra client names matching `^[a-z][a-z0-9-]{0,31}$` (`tokens.ts` line 117). Those three ids must stay, with those exact source lists, or the gate refuses to start.

The gate reads the token file once at process start (`scripts/grok-shared-brain/cli-gate.ts`). A new hash applies only after the LaunchAgent is restarted.

### Mint and register

The generator prints plaintext once on stdout and writes hashes only. Send stdout to a new 0600 file. Do not `tee` it, and do not display the file.

```bash
umask 077
install -m 700 -d <PRIVATE-PATH>/.gbrain/serve
bun scripts/grok-shared-brain/cli-generate-tokens.ts \
  --out <PRIVATE-PATH>/.gbrain/serve/funnel-tokens.json \
  > <PRIVATE-PATH>/.gbrain/serve/funnel-bearers.once
chmod 600 <PRIVATE-PATH>/.gbrain/serve/funnel-bearers.once
chmod 600 <PRIVATE-PATH>/.gbrain/serve/funnel-tokens.json
```

Stderr names the hash file and `funnel_enabled=false`. It does not contain the bearers. If the hash file already exists, the command refuses until `--force`. `--force` replaces every client hash. Restart the gate only after each bot's connector secret has been updated, or the previous bearers stop working.

Point the three clients at grant files. This command does not read or print the grants (`cli-set-upstream-tokens.ts`):

```bash
bun scripts/grok-shared-brain/cli-set-upstream-tokens.ts \
  --tokens <PRIVATE-PATH>/.gbrain/serve/funnel-tokens.json \
  --grants <PRIVATE-PATH>/.gbrain/serve/grants
```

Issue each grant to loopback serve, not to the MagicDNS name. The gate presents that grant to `127.0.0.1:8766`. The steps are in `docs/grok/shared-brain/README.md`. Redirect grant stdout away from the terminal the same way that file does. `gbrain mcp grant` `--url` is `http://127.0.0.1:8766/mcp`. MagicDNS is the gate, and the gate answers `/token` and `/admin` with `403` `admin_forbidden`.

### Upstream access token lifetime

`grok-bot` is a renewable harness. A new grant's access-token lifetime is 3600 seconds (`src/core/grants/profiles.ts` `RENEWABLE_GRANT_TTL_SECONDS`, line 9, applied at line 75). `gbrain serve --http` uses the same 3600-second default when the client row has no override (`src/cli/help/serve.ts`). `--token-ttl SECONDS` on `gbrain mcp grant` overrides that lifetime for a new client (`src/commands/mcp.ts` line 39). The allowed range is 60 through 7776000 seconds.

Re-running `gbrain mcp grant` with `--client` on a client that already exists updates the registration and keeps the old credential file. It does not write a new `access_token` (`src/commands/mcp-provision.ts` line 100, `existing_credentials_preserved`). The gate does not need that re-grant in order to mint a new access token.

These grants use `client_credentials`. The issued access token has no `resource` (`src/core/oauth-grants.ts` `clientCredentials`, line 337 passes `undefined`). Serve checks a token's resource only when one is set (`src/commands/serve-http.ts` lines 790–798). A JSON-RPC auth error after a good gate bearer is not a MagicDNS Host mismatch. Serve's own issuer is `--public-url` when that flag is set, otherwise `http://localhost:<port>` (`src/commands/serve-http.ts` line 650). That issuer is independent of the Tailscale Host. `127.0.0.1` and `localhost` are different origins if some later token is resource-bound. This connector's client-credentials tokens are not.

The normal path is the gate (`scripts/grok-shared-brain/upstream-token.ts`). Before it proxies, it reads the grant file. If the file has `client_id` and `client_secret`, and 60 seconds or less remain before `expires_at` (`UPSTREAM_REFRESH_MARGIN_SECONDS`), including a token that is already expired, or `access_token` is missing, it POSTs `grant_type=client_credentials` to the loopback upstream's `/token` (`http://127.0.0.1:8766/token`). That request does not go through the gate. The gate answers `/token` with `403` `admin_forbidden`. One refresh is in flight per grant file. After `/token` answers, the gate reads the file again and writes only the new `access_token` and `expires_at` into that latest JSON. If `client_id` or `client_secret` changed while the exchange was in flight, the minted token is discarded and the file is left as it is. This request uses the file's current access token when it has one. A 401 from serve for that token is passed through. The rewrite is a temp file in the same directory, mode 0600, fsync, then rename. The re-read and that rename are not one locked step, so another writer can replace the file between them. `expires_at` becomes now plus `expires_in`, or 3600 seconds when `/token` omits `expires_in`. The log line stays method, path, client id, and status (`gate.ts` `finish`, lines 334–337). It must not contain the access token or the client secret.

A file that has an `access_token` and no client credentials is sent as-is. The gate does not call `/token`, and an upstream 401 is passed through unchanged. A file with no `access_token`, no `expires_at`, and no `client_id` or `client_secret` is `502` `{"error":"bad_gateway"}`. The same `502` `bad_gateway` is an unreadable grant file. `401` `{"error":"upstream_unauthorized"}` is only an exchange that was attempted and refused: `/token` returned 401 or 403, or a new token is required (expired, inside the margin, or `access_token` missing while `expires_at` is set) and the file has no `client_id` or `client_secret`.

If the file has client credentials and serve then returns 401, the gate exchanges once more and proxies that new token once. It does not loop. Any other exchange failure, including a failed rewrite, becomes `502` `{"error":"upstream_token_refresh_failed"}`. Neither body contains the secret.

The script below is recovery, not the standing path. Use it when the gate returns `upstream_unauthorized` or `upstream_token_refresh_failed`, or when the gate is stopped and the file should be rewritten by hand. It reads the grant, posts `client_id` and `client_secret` in the body, and writes the new `access_token` and `expires_at` back. It prints neither. Point `G` at the grant JSON. The URL is loopback serve, not MagicDNS:

```bash
umask 077
export G=<PRIVATE-PATH>/.gbrain/serve/grants/personal.json
python3 -c 'import json,os,time,urllib.parse,urllib.request,urllib.error
p=os.environ["G"]
d=json.load(open(p))
body=urllib.parse.urlencode({"grant_type":"client_credentials","client_id":d["client_id"],"client_secret":d["client_secret"]}).encode()
req=urllib.request.Request("http://127.0.0.1:8766/token",data=body,method="POST")
req.add_header("Content-Type","application/x-www-form-urlencoded")
try:
    payload=json.load(urllib.request.urlopen(req,timeout=15))
except urllib.error.HTTPError as e:
    raise SystemExit("token endpoint HTTP %s"%e.code)
tok,exp=payload.get("access_token"),payload.get("expires_in")
if not isinstance(tok,str) or not tok or not isinstance(exp,int):
    raise SystemExit("token endpoint returned no access_token")
d["access_token"]=tok
d["expires_at"]=int(time.time())+exp
tmp=p+".tmp"
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
try:
    os.write(fd,(json.dumps(d,indent=2)+"\n").encode())
finally:
    os.close(fd)
os.replace(tmp,p)
os.chmod(p,0o600)
print("rewrote grant file")'
unset G
```

The gate reads that file on the next request. This rewrite does not need `launchctl kickstart`. Repeat it for `business.json` and `hermes.json`, and for any extra bot's grant file, when you are recovering by hand. The standing path does not need cron. The script still must not print the token. Passing `--token-ttl` on a later grant of the same `--client` changes the lifetime of the next token the gate or this script mints. It does not, by itself, replace `access_token` in the file.

For an additional bot, keep the three required clients and add one object to `clients`. Create the secret and its hash in files. The command writes those files and prints neither the secret nor a prompt:

```bash
umask 077
export F=<PRIVATE-PATH>/.gbrain/serve/<bot>-bearer.once
export H=<PRIVATE-PATH>/.gbrain/serve/<bot>-bearer.sha256
python3 -c 'import os,base64,hashlib,pathlib; p=pathlib.Path(os.environ["F"]); t="gbft_"+base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="); p.write_bytes(t.encode()); os.chmod(p,0o600); h=pathlib.Path(os.environ["H"]); h.write_text(hashlib.sha256(t.encode()).hexdigest()+"\n"); os.chmod(h,0o600)'
unset F H
```

`<bot>` is the new client id. Read only the hash file and paste that line into `token_sha256`. Set `routes` to `["health","mcp"]`, and set `write` and `read` to that bot's sources. Do not list `shared` under `write`.

Issue a loopback grant for that same name. `--token-ttl` belongs on this create, when a lifetime other than 3600 seconds is wanted. Stdout stays discarded. `cli-set-upstream-tokens.ts` updates only `personal`, `business`, and `hermes`, so set this client's `upstream_token_file` by hand to the absolute grant path. A relative path is refused (`tokens.ts` line 129).

```bash
umask 077
mkdir -p <PRIVATE-PATH>/.gbrain/serve/grants
chmod 700 <PRIVATE-PATH>/.gbrain/serve/grants
gbrain mcp grant <bot> --harness grok-bot --profile memory-writer \
  --source <bot> --federated-read <bot>,shared --skills memory-only \
  --url "http://127.0.0.1:8766/mcp" \
  --admin-token-file <PRIVATE-PATH>/.gbrain/serve/admin-token \
  --credentials-out <PRIVATE-PATH>/.gbrain/serve/grants/<bot>.json \
  --json >/dev/null
chmod 600 <PRIVATE-PATH>/.gbrain/serve/grants/<bot>.json
```

`<bot>` in `--source` is that bot's own source id. Use the source that already exists. Do not invent `shared` as a write source. In `funnel-tokens.json`, set `upstream_token_file` to `<PRIVATE-PATH>/.gbrain/serve/grants/<bot>.json`. Copy the bearer file into the connector secret without displaying it, then remove the bearer file. Restart the gate so it loads the new client:

```bash
launchctl kickstart -k "gui/$(id -u)/com.gbrain.funnel-gate"
```

### Revoke

Revoking a gate bearer is a hash rotation or a removal, then a gate restart. Deleting the plaintext file does nothing while the hash is still loaded.

- For `personal`, `business`, or `hermes`, write a new `token_sha256` (mint again into a 0600 file, or replace that one hash). The parser will not start if one of those clients is missing.
- For an extra bot, delete that client object.
- Restart with the `launchctl kickstart` command above. The next request with the old bearer is `401`.
- Shred the plaintext file after the connector secret is cleared. Do not `cat` it.

That does not revoke the upstream gbrain grant. The gate would still present the old grant for any bot that still has a valid gate bearer. Preview, then apply, against loopback. Admin routes on the gate are `403`, so this URL is `127.0.0.1:8766`, not the MagicDNS name (`docs/mcp/ADMIN.md`):

```bash
gbrain mcp admin revoke CLIENT_ID \
  --url http://127.0.0.1:8766/mcp \
  --admin-token-file <PRIVATE-PATH>/.gbrain/serve/admin-token \
  --json
```

Apply with the revision the preview prints: add `--yes --if-version REVISION`. Do not print the admin token file.

## Verification

Expect `401` and `{"error":"unauthorized"}` when the gate bearer is absent or wrong. A good bearer reaches serve. `initialize` and `tools/list` have no source and are allowed by the gate (`mcp-policy.ts` lines 21–24 and 78).

Put the secret in a 0600 curl config, not on the command line. Example, with `<TOKEN>` standing in for the file's real contents:

Good-bearer config, mode 0600. `<TOKEN>` stands in for the file's real contents. `Accept` is `application/json` so the body is a JSON-RPC object:

```
silent
show-error
header = "Authorization: Bearer <TOKEN>"
header = "Content-Type: application/json"
header = "Accept: application/json"
```

Wrong-bearer config, also mode 0600. The value `wrong-token` is a dummy, and it stays in this file so it is not a curl argument:

```
silent
show-error
header = "Authorization: Bearer wrong-token"
```

From a tailnet member (`<BOT-DEVICE>` or the Mac):

```bash
# unauthenticated GET. The gate checks the bearer before the method. Expect 401.
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://<MAC-HOST>.<TAILNET>.ts.net/mcp"

# wrong bearer, from the 0600 config above. Expect 401.
curl -s -o /dev/null -w '%{http_code}\n' \
  --config <PRIVATE-PATH>/mcp-wrong.curlrc \
  "https://<MAC-HOST>.<TAILNET>.ts.net/mcp"

# good bearer. Expect HTTP 200 and a JSON-RPC object (initialize, then tools/list).
curl -s -w '\n%{http_code}\n' --config <PRIVATE-PATH>/mcp-check.curlrc \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
  "https://<MAC-HOST>.<TAILNET>.ts.net/mcp"

curl -s -w '\n%{http_code}\n' --config <PRIVATE-PATH>/mcp-check.curlrc \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  "https://<MAC-HOST>.<TAILNET>.ts.net/mcp"
```

If those two posts return SSE instead of a JSON object, the curl config sent `Accept: text/event-stream`. A successful SSE body is `event: message` plus a `data:` line containing the JSON-RPC object. Use `Accept: application/json` for the object.

From a machine that is not on the tailnet, the same URL must fail before HTTP (DNS or connect). A `200` or a `401` from off-tailnet means the name is reachable outside the tailnet. Stop and re-check Funnel.

On the Mac, this does not need a bearer and does not prove the tailnet path. It only proves the gate process is up:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8767/health
```

Expect `401`.

If the good bearer returns `502` `bad_gateway`, the gate accepted the bot and could not read `upstream_token_file`, or the upstream connection failed. `502` `upstream_token_refresh_failed` means the loopback `/token` exchange failed. `401` `upstream_unauthorized` means the grant's client credentials were refused. Use the recovery script above for those two. A JSON-RPC auth error after the gate's one retry means serve rejected the new access token too. Client-credentials tokens are not audience-bound, so that is not a MagicDNS mismatch. Gate logs are method, path, client id, and status (`gate.ts` `finish`, lines 334–337). They must not contain `<TOKEN>` or the grant secret.

## Risks

- A `/` proxy to `127.0.0.1:8766` publishes serve's unauthenticated `/health` and its `/admin` listener on the tailnet. The proxy target stays `8767`.
- Funnel publishes that same gate on the public internet. The bearer would be the only control. Leave Funnel off.
- Any tailnet device that ACLs allow can present a stolen bearer. The gate does not check which Tailscale identity connected.
- One `tailscale serve` `/` handler on 443 replaces whatever that path proxied before. Loopback `127.0.0.1:8766` is unchanged. A client that called the MagicDNS name with a gbrain access token, and no gate bearer, will get `401` from the gate.
- The bot bearer and the grant `access_token` are different secrets. A `grok-bot` access token expires after 3600 seconds unless create used `--token-ttl`. The gate refreshes the grant file before that expiry, and once more after an upstream 401. The manual `/token` rewrite is recovery when that refresh fails.
- The token file is loaded at start. Until `launchctl kickstart`, an old hash still works.
- Default limit is 60 requests per 60 seconds per client id, then `429`.
- `initialize` and `tools/list` do not prove a write. A `tools/call` must name an allowed source. `shared` writes are `403`.
- Shell tracing, a curl config left world-readable, or displaying `funnel-bearers.once` leaks the bearer. The hash file does not.

## Rollback

On the Mac, turn the HTTPS `/` mount off without wiping other handlers:

```bash
tailscale serve --https=443 --set-path=/ off
tailscale serve status --json
```

Confirm `Proxy` is no longer `http://127.0.0.1:8767` and `AllowFunnel` is still not `true`. Do not run `tailscale funnel` while backing out. Remove the connector URL from each bot, then rotate or leave the hash file. Restarting the gate is optional once Tailscale no longer forwards to it. Loopback serve on `127.0.0.1:8766` keeps running.

To restore the previous tailnet publish, run the previous `tailscale serve --bg <port>` only after this check still shows Funnel off. Do not point that command at 8766 unless the operator accepts unauthenticated `/health` on the tailnet again.
