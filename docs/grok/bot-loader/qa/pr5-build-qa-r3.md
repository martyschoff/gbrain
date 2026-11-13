# gbrain PR #5 build QA r3

- Head checked: 604af40191e6cfd22ec5b671ed55bcf8a73bf93a (branch feature/multi-account-bot-export)
- Base: origin/grok 3f81d6c517cd8d80b52f421dceb7836708f9e084
- Reviewer: CloudQA via Cursor cloud agent bc-c1b81c41, model grok-4.6 (effort medium). Same model family as the grok-4.7 builder, so this is not an independent-family check.
- Read-only review with synthetic fixtures only.

Verdict: FAIL

Reviewer is grok-4.6 (same family as the grok-4.7 builder; not an independent-family check). Read-only. `git rev-parse HEAD` = `604af40191e6cfd22ec5b671ed55bcf8a73bf93a`. PR #5 base `origin/grok` = `3f81d6c517cd8d80b52f421dceb7836708f9e084`. r2 head `8b0ede11` is an ancestor. Synthetic `/tmp` fixtures only.

The address requirement in `looksLikeMail` / `looks_like_mail` does what r2 asked, and it re-opens r1 Medium 2: address-less pasted mail is exported and ingested.

## What ran

| Command | Claim | Actual |
| --- | --- | --- |
| `git rev-parse HEAD` | `604af401…` | `604af40191e6cfd22ec5b671ed55bcf8a73bf93a` |
| GitHub PR #5 body Tests block (`get_pull_request`) | 51 pass / 0 fail / 645 `expect()` | Body text is exactly that. |
| `git diff --stat 8b0ede11..HEAD` | r2→HEAD | 6 files, **+370 / −25** |
| `git diff --stat origin/grok...HEAD` | PR vs grok | 17 files, **+2351 / −107**. All under `docs/grok/bot-loader`, `scripts/bot-loader`, `test/bot-loader*.ts`. No PR #6 heap files. |
| `python3 scripts/bot-loader/test_secret_rules.py` | 3 OK | Exit **0**. `Ran 3 tests in 0.004s` / `OK` |
| `bun test --timeout=60000 test/bot-loader-multi-account.test.ts test/bot-loader.test.ts` | 51 / 0 / 645 | Exit **0**. **51 pass / 0 fail / 645 expect() calls**. Ran 51 tests across 2 files. [3.22s] |
| `bun run typecheck` | exit 0, heap 12288 | Script is `node --max-old-space-size=12288 node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile node_modules/.cache/gbrain-typecheck.tsbuildinfo`. Exit **0**. |
| TS+PY+exporter corpus (40 cases) | agree; r2 benign/positives | **0 TS/Python disagreements** on `denied` / `mail`. Address-less mail exported (Finding 1). |
| `/tmp` mutations | each ≥1 fail | 8/9 mutations failed ≥1 official test. **`yaml-ignore-off` did not** (51/0). |
| grok `box-export.py` vs HEAD `--fail-closed --source acme-biz --account acme-biz` | deny-list drops only | Same UTC stamp `2026-11-12T23:40:35Z`. Shared payloads byte-identical. HEAD dropped `holdings.md` and `password.md`; **kept address-less `mail.md`**. |
| HEAD `checkFailClosed` + `runLoader` on HEAD tree | accept | grok tree: `ok=false skip=finance-data`. HEAD: `ok=true` 6 files including `attachments/mail.md`. Loader exit 0, put slug `example-bot/attachments/mail`. |

## Diff / merge (A)

`8b0ede11..HEAD`: `docs/grok/bot-loader/qa/pr5-build-qa-r2.md`, `export-deny.json`, `export-deny.ts`, `export_deny.py`, `test_secret_rules.py`, `test/bot-loader-multi-account.test.ts`.

Merge `604af4019` parents: `014a7bc18` (local narrowing) + `7adb54283` (origin partial narrowing). Origin used `mail_other_headers` + leading-YAML strip + mixed-case `api_key` lookahead. HEAD kept one JSON: `mail_headers` + `mail_address_headers` + `mail_strong_headers` + `key_assignment`. No `mail_other_headers` leftover. TS and Python implement the same HEAD rules (no duplicate/dead origin helper). `fail-closed.ts` is not in the PR diff. No `<<<<<<<` in bot-loader sources (only the word in r2 QA prose).

## r2 claimed fixes

| # | Claim | Status |
| --- | --- | --- |
| 1 | PR body 645 expect / 51 pass / 0 fail | **Matches** bun output. |
| 2 | Mail deny only with address on From/To/Cc/Bcc/Reply-To/Return-Path, or Message-ID/Received; YAML `---` ignored | **Implemented** (`export-deny.ts:87-116`, `export_deny.py:90-121`, `export-deny.json:30-34`). **Re-opens r1 Medium 2** (Finding 1). YAML skip is real but **not independently tested** (Finding 2). |
| 3 | brokerage/tax-lot content patterns gone; `holdings` still denied | **Fixed.** Content array ends with `\bholdings\b` only. Filename still has `brokerage` / `tax-lot`. Mutations: re-add `\bbrokerage\b` → PY FAIL + bun 49/2. |
| 4 | placeholder `api_key`/`access_token` allowed; `not-a-real-value` and mixed alnum still denied | **True for `deniedExportContent` / `denied_content`.** `api_key=YOUR_KEY_HERE` / `xxxxxxxx` / `EXAMPLEabc123def456` / `ALLCAPSWITH123DIGITS` are still omitted by **`box-export.py` via `secret_content`** (`secret-patterns.json` `api_key=\S`, added in this PR) (Finding 3). |

## Corpus (C)

TS = `deniedExportContent` / `looksLikeMail`. PY = `denied_content` / `looks_like_mail`. Exporter = HEAD `box-export.py` per-bot notes with safe names `note00.md`… (`denied_name` does not fire). **No TS/PY disagreement.**

| id | group | TS denied | PY denied | TS mail | PY mail | exported |
| --- | --- | --- | --- | --- | --- | --- |
| yaml-from-date | benign | n | n | n | n | **yes** |
| date-subject-meeting | benign | n | n | n | n | **yes** |
| to-date | benign | n | n | n | n | **yes** |
| brokerage-fees | benign | n | n | n | n | **yes** |
| tax-lot-method | benign | n | n | n | n | **yes** |
| fenced-api-key-see | benign | n | n | n | n | **yes** |
| password-policy | benign | n | n | n | n | **yes** |
| holding-pattern | benign | n | n | n | n | **yes** |
| place-the-cup | benign | n | n | n | n | **yes** |
| ipv4-public | benign | n | n | n | n | **yes** |
| from-ada-no-at | r2 test | n | n | n | n | **yes** |
| mail-from-addr | positive | y | y | y | y | no |
| mail-to-angle | positive | y | y | y | y | no |
| message-id-received | positive | y | y | y | y | no |
| password-colon | positive | y | y | n | n | no |
| api-key-realish | positive | y | y | n | n | no |
| access-token-realish | positive | y | y | n | n | no |
| ssn | positive | y | y | n | n | no |
| dotted-phone | positive | y | y | n | n | no |
| plus1-phone | positive | y | y | n | n | no |
| example-place | positive | y | y | n | n | no |
| holdings-body | positive | y | y | n | n | no |
| email-addr | positive | y | y | n | n | no |
| private-key-header | positive | n | n | n | n | no (`secret_content`) |
| ph-your-key `api_key=YOUR_KEY_HERE` | placeholder | n | n | n | n | **no** (`secret_content`) |
| ph-angle `api_key: <redacted>` | placeholder | n | n | n | n | yes |
| ph-xxx `api_key=xxxxxxxx` | placeholder | n | n | n | n | **no** (`secret_content`) |
| ph-example-prefix `api_key=EXAMPLEabc123def456` | placeholder | n | n | n | n | **no** (`secret_content`; EXAMPLE* prefix **would** pass export-deny) |
| ph-allcaps-digits `ALLCAPSWITH123DIGITS` | placeholder | n | n | n | n | **no** (`secret_content`) |
| ph-see-vault `access_token: SEE_VAULT` | placeholder | n | n | n | n | yes |
| not-a-real-value | placeholder | y | y | n | n | no |
| yaml-mail-in-fence (addrs) | yaml | y | y | **n** | **n** | no (email content regex; mail scan skipped) |
| yaml-mail-unclosed (addrs) | yaml | y | y | **n** | **n** | no (same) |
| yaml-mail-unclosed-nameless | yaml | n | n | n | n | **yes** |
| addrless-ada-invoice | mail | n | n | n | n | **yes** |
| addrless-on-wrote | mail | n | n | n | n | **yes** |
| addrless-original-message | mail | n | n | n | n | **yes** |
| addrless-outlook | mail | n | n | n | n | **yes** |
| addrless-gmail-fwd | mail | n | n | n | n | **yes** |
| addrless-from-to-subject-date | mail | n | n | n | n | **yes** |

Exporter stdout: `bot bot-a files=23 secrets_skipped=20`.

## Mutations (D)

Copy `/tmp/qa-mut/work` only. Official bun pair + `python3 scripts/bot-loader/test_secret_rules.py`.

| Mutation | bun | python | Discriminating fail |
| --- | --- | --- | --- |
| mail-address-off (`headers >= MIN` only) | 49/2 | FAIL 1 | `From: ada` + `Subject:` now denied; `secret list` (python status) |
| yaml-ignore-off | **51/0** | **OK** | **none** |
| brokerage-readd | 49/2 | FAIL 1 | `We talked about brokerage fees yesterday.` |
| placeholder-off | 49/2 | FAIL 1 | `api_key: SEE_HANDBOOK` |
| size-check-off | 50/1 | OK | `a size mismatch is skipped when the sha256 still matches` |
| unknown-key-off | 50/1 | OK | `an unknown manifest key imports nothing from that folder` |
| stale-off | 50/1 | OK | `a stamp outside the age window imports nothing` |
| missing → `hash mismatch` | 50/1 | OK | `a listed file that is gone logs missing` |
| `--fail-closed` → `export_tree` | 49/2 | OK | `box export writes a per-bot manifest…`; `a fail-closed export is accepted…` |

## Byte-match (E)

PR #4 / grok producer: `git show origin/grok:scripts/bot-loader/box-export.py` with grok `secret_rules.py` + `secret-patterns.json`, `--account acme-biz --source acme-biz`. HEAD: `box-export.py --fail-closed --source acme-biz --account acme-biz`. Same synthetic agent. No faketime; both stamps `2026-11-12T23:40:35Z`.

**Identical:** layout `example-bot/{profile.json,memory/profile.md,memory/log/*.md,attachments/*}`; MANIFEST key order `version, account, source, exported_at, files, file_count, byte_count`; `json.dumps(..., indent=2)+"\n"`; lowercase hex; file mode `0644`; dirs `0755` (temp root `0700` both). Six shared file payloads **byte-equal**.

**Differences (deny-list drops + counts only):**

| Path | grok | HEAD |
| --- | --- | --- |
| `attachments/holdings.md` | present | omitted (`\bholdings\b`) |
| `attachments/password.md` | present | omitted (`password:` + secret-patterns) |
| `attachments/mail.md` | present (`From:`+`Subject:`, no `@`) | **present (same bytes)** |
| `EXPORTED_AT` line 2 | `example-bot 8` | `example-bot 6` |
| MANIFEST `file_count` / `byte_count` | 8 / 183 | 6 / 123 |
| stdout | `files=8 secrets_skipped=0` | `files=6 secrets_skipped=2` |

r2 HEAD omitted `mail.md`; this HEAD does not. `checkFailClosed` on grok tree: **`finance-data`**. HEAD tree accepted; loader wrote `example-bot/attachments/mail`.

## r1 Mediums / strengths (F)

Official HEAD tests passed: size-mismatch; `--source` without `--fail-closed` refused; `--fail-closed` signed tree accepted; symlink + path escape; mid-run manifest swap; second run `written=0` `unchanged=5`; orphans; account mismatch; stamp outside 36h → `stale`.

## Privacy (G)

`git diff -U0 origin/grok...HEAD` added lines: emails only `@example.com` (QA/docs/tests). `<BUSINESS-HANDLE>` and `/Users/` appear only as “none found” prose in QA docs. `1.2.3.4` / `10.30.2026` are corpus strings, not private IPs. No token-shaped prefixes. Tests still concatenate `555`+`010`+`0199`.

## Findings

1. **Medium** — `scripts/bot-loader/export-deny.ts:87-116`, `export_deny.py:90-121`, `box-export.py:90-91`. r1 Medium 2 is open again. Address-less mail (`From: Ada Lovelace` / `Subject: Re: invoice` / `Date:`; Outlook `From`/`Sent`/`To`/`Subject`; `-----Original Message-----`; Gmail `---------- Forwarded message ---------`; `On <date>, X wrote:`) has `looksLikeMail=false`, is copied by `box-export.py`, and the fail-closed loader ingested `attachments/mail.md`. r2 benign YAML `from:`+`date:`, `Date:`+`Subject:` meeting notes, and `To:`+`Date:` still pass and should stay passing. **Fix:** keep the `@` / `<…@…>` rule, and also deny when ≥3 contiguous header-shaped lines at the top *outside* YAML (`From`/`To`/`Cc`/`Bcc`/`Subject`/`Date`/`Sent`/`Reply-To`) **or** when `Original Message` / `Forwarded message` / `wrote:` markers appear in the scan window. Pin those six address-less fixtures as `denied=true` / not exported; keep the current YAML and two-header meeting-note negatives.

2. **Low** — same mail/YAML path. Mutation `yaml-ignore-off` (do not skip `---` fences) → **51 pass / 0 fail**, Python OK. Official YAML fixtures have no address, so the address rule already lets them through. Unclosed `---` also hides `Message-ID`/`Received` from the mail scan. **Fix:** add a test that `Received:` + `Message-ID: <fake.1>` inside an unclosed or closed `---` fence is still denied (or document that only a *leading closed* front matter block is ignored, matching origin `7adb54283` `_without_front_matter`).

3. **Low** — `scripts/bot-loader/secret-patterns.json` `api_key=\S` vs `export-deny.ts:67-84`. r2 said placeholder `YOUR_*` / `xxx` / `EXAMPLE*` / ALL_CAPS are kept. That is true for `deniedExportContent`. `box-export.py` still uses `secret_content or denied_content`, so `api_key=YOUR_KEY_HERE`, `api_key=xxxxxxxx`, `api_key=EXAMPLEabc123def456`, and `api_key=ALLCAPSWITH123DIGITS` are skipped. Colon forms (`api_key: <redacted>`, `access_token: SEE_VAULT`) export. **Fix:** apply the same placeholder allowlist in `secret_rules` for `api_key`/`access_token` assignments, or change the PR text to “colon handbook examples only,” and add an exporter test.

## Could not check

- Docker / `bun run test:e2e` / `bun run ci:local` / full `bun test`.
- Live share mounts or real account drops.
- Windows path semantics.
- `libfaketime` (producers shared the same UTC second without it).
- Independent model family (same family as the builder).

