# gbrain PR #5 build QA, round 2: FAIL

- PR: https://github.com/martyschoff/gbrain/pull/5
- Head checked: 8b0ede1148c6b6c64298c639efd5cfa6bee10ab2 (r1 was 1984702d; base origin/grok 3f81d6c5)
- Reviewer: CloudQA via Cursor cloud agent bc-81d79888, model grok-4.6, effort medium (read-only; same model family as the grok-4.7 builder, so not an independent-family check)
- Date: 12 Nov 2026 (ET)

---

Verdict: FAIL

Read-only review of `8b0ede1148c6b6c64298c639efd5cfa6bee10ab2` (`git rev-parse HEAD` matched). Base `origin/grok` after fetch is `3f81d6c517cd8d80b52f421dceb7836708f9e084` (PR #6 heap 12288). Experiments used `/tmp` synthetic fixtures only.

## What ran

| Command | Claim | Actual |
| --- | --- | --- |
| `git rev-parse HEAD` | `8b0ede11…` | `8b0ede1148c6b6c64298c639efd5cfa6bee10ab2` |
| `git fetch origin grok`; `git diff --stat 1984702d..HEAD` | r1→HEAD | 18 files, **+583 / −25** (includes grok merge: `package.json`, `docs/operations/verify-and-nightly-e2e.md`, `docs/grok/bot-loader/qa/pr6-build-qa-r1.md`) |
| `git diff --stat origin/grok...HEAD` | PR vs grok | 16 files, **+2006 / −107**. No PR #6/#7 files. `package.json` is identical to grok (`12288`). |
| `python3 scripts/bot-loader/test_secret_rules.py` | 3 OK | Exit **0**. `Ran 3 tests in 0.002s` / `OK` |
| `bun test --timeout=60000 test/bot-loader-multi-account.test.ts test/bot-loader.test.ts` | builder 51/0, 630 expects; PR body 631 | Exit **0**. **51 pass / 0 fail / 630 expect() calls**. Ran 51 tests across 2 files. [3.29s] |
| `bun run typecheck` (script as-is) | exit 0, heap 12288 | Script is `node --max-old-space-size=12288 node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile node_modules/.cache/gbrain-typecheck.tsbuildinfo`. Exit **0**. |
| PR4 producer vs HEAD `--fail-closed --source acme-biz` on same `/tmp` agent | byte-match | Same UTC stamp `2026-11-12T23:22:48Z`. Shared 7 files **byte-identical** mode `0644`. Trees **not** identical (see Byte-match). |
| HEAD `checkFailClosed` + loader on both trees | both accepted | PR4: `ok=false skip=finance-data` / `SKIP acme-biz: finance-data`. HEAD: `ok=true` 7 files, loader exit 0, no SKIP. |
| TS+Python deny corpus (45 benign + 15 positive) | agree; catch claimed classes | **0 TS/Python disagreements**. Positives all denied. Benign/probe FPs below. |
| Injected-`now` age/DST harness (`/tmp/qa-pr5/age.test.ts`) | 36h ±1s, DST, default 36 | **16 pass / 0 fail** (see DST table). |
| `/tmp` mutations of a copy | each ≥1 fail | All 14 mutations failed ≥1 official test (see mutation table). |
| r1 strengths harness | symlink/escape/swap/idemp/orphan/account | **6 pass / 0 fail**. |

## Diff / merge (A)

`origin/grok...HEAD` files: README, `config.example.json`, `multi-account-export.md`, `qa/pr5-build-qa-r1.md`, `box-export.py`, `config.ts`, `export-deny.json/.ts`, `export_deny.py`, `multi-account.ts`, `render.ts`, `run.ts`, `secret-patterns.json`, `test_secret_rules.py`, `test/bot-loader-multi-account.test.ts`, `test/bot-loader.test.ts`.

No PR #6 typecheck/heap files in the grok three-dot diff. `render.ts` is original PR #5 (`1984702d`), not r1→HEAD. Merge `97cd0301c` is `1984702d` + `3f81d6c51` and only brought those three grok files. No `<<<<<<<` residue in bot-loader paths. Fail-closed reader on grok is unchanged (`fail-closed.ts` not in the PR diff).

## r1 findings status

| # | Claimed fix | Status |
| --- | --- | --- |
| 1 Med size unpinned | same-sha wrong-size → `size mismatch`; size-check-off fails tests | **Fixed.** Test at `test/bot-loader-multi-account.test.ts` (size-mismatch case). Check `scripts/bot-loader/multi-account.ts:327-330`. Mutation `size-check-off`: **50 pass / 1 fail** (`a size mismatch is skipped when the sha256 still matches`). |
| 2 Med mail-header note exported | ≥2 RFC822 headers in first 20 lines denied; TS/Python same JSON; single `Subject:` and `From the hill` pass | **Mostly fixed, residual FPs.** `export-deny.json:29-31`, `export-deny.ts:39-54`, `export_deny.py:50-64`. Exporter no longer writes `notes/body.md`. TS and Python agreed on every corpus line. |
| 3 Med #4 producer lost | `--fail-closed --source` writes `EXPORTED_AT` + tree `MANIFEST.json`; `--source` without flag refused; default per-bot unchanged | **Shape restored.** Official tests cover refusal + signed tree + `checkFailClosed`. Mutation that routes `--fail-closed` to `export_tree`: **49/2**. Trees are **not** byte-identical to grok `box-export.py` (stricter denylist). |
| 4 Low unknown keys | reject unknown manifest and file-entry keys | **Fixed.** `multi-account.ts:66-67,153,166`. Mutation `unknown-key-off`: **50/1**. |
| 5 Low stale window | `exported_at` outside 36h either way → `stale` | **Fixed** for the per-bot drop (`stampFresh` `multi-account.ts:178-187`). DST/±1s table below. |
| 6 Low missing listed file | log `missing` | **Fixed.** `multi-account.ts:309-312`. Mutation: **50/1**. |
| 7 Low example `export_roots` | `<EXPORT-ROOT>` placeholders | **Fixed.** `docs/grok/bot-loader/config.example.json:59-72`. Loader allows literal `_box-export-<ACCOUNT-B>` basename (`config.ts:381-383`) so the example loads. |
| 8 Low new patterns | password:, api_key=, SSN, dotted/+1 phone, Place, holdings in body; narrowed holding / lowercase place | **Pinned** (each pattern mutation **49/2** bun + Python FAIL). Residual ordinary-prose hits: brokerage / tax-lot / fenced `api_key:`. |
| PR text 10 of 11 | corrected | PR body now says reverting `run.ts` fails **10 of 11**. Still says **631** expect() calls; bun reports **630**. |

## Byte-match (B)

PR #4 producer: `git show origin/grok:scripts/bot-loader/box-export.py` (blob sha256 `65ecfbcf…`, commit `43fa5c848`, same as merge `c1080d1f9`). Ran with grok `secret_rules.py` + grok `secret-patterns.json`.

Same synthetic agent, same `--out`, `--account acme-biz --source acme-biz`. HEAD added `--fail-closed`. No faketime; both stamps were `2026-11-12T23:22:48Z`.

**Identical:** layout `example-bot/{profile.json,memory/profile.md,memory/log/*.md,attachments/*.md,txt}`; MANIFEST key order `version, account, source, exported_at, files, file_count, byte_count`; `json.dumps(..., indent=2)+"\n"`; sha strings lowercase hex; file mode `0644`; dirs `0755`; seven shared file payloads byte-equal.

**Differences:**

| Path | PR4 | HEAD |
| --- | --- | --- |
| `attachments/holdings.md` | present (`The holdings list stays offline.`) | omitted (`denied_content` `\bholdings\b`) |
| `attachments/mail.md` | present (`From:`+`Subject:`) | omitted (`looks_like_mail`) |
| `attachments/password.md` | present (`password: …`) | omitted (`password:` rule + HEAD `secret-patterns.json`) |
| `EXPORTED_AT` line 2 | `example-bot 10` | `example-bot 7` |
| `MANIFEST.json` `file_count` / `byte_count` | 10 / 273 | 7 / 179 |
| stdout | `files=10 secrets_skipped=0` | `files=7 secrets_skipped=3` |

Cause: HEAD `--fail-closed` uses `sensitive_text` = `secret_content` **or** `denied_content` (`box-export.py:86-91`); grok producer used only `secret_rules`. Also HEAD skips symlink roots (`export_fail_closed`); fixture was not a symlink.

`checkFailClosed` (HEAD) on PR4 tree: **`finance-data`** because `holdings.md` matches `fail-closed.ts:10` `FINANCE_RE`. HEAD tree accepted; loader exit 0.

## False positives (C)

45 benign lines. TS (`deniedExportContent` / `looksLikeMail`) and Python (`denied_content` / `looks_like_mail`) **agreed on every line** (same `denied` and same hit list).

**Benign corpus (intended-safe):**

| Line | Denied? | Rule |
| --- | --- | --- |
| `Password policy: rotate quarterly` | no | |
| `From the hill the path was clear.` | no | |
| `Subject: tomorrow's plan` (alone) | no | |
| `Date: Tuesday` (alone) | no | |
| `holding pattern…` / `Place the cup…` / `meet at Example Place…` | no | |
| `1.2.3.4` / `10.30.2026` / ISBN / `5550100199` | no | |
| YAML `title:` + `date:` only | no | one mail header |
| `The api key is rotated quarterly.` | no | |
| `A holding company… not holdings.` | **yes** | `\bholdings\b` (the line contains the word `holdings`) |
| fenced `api_key: SEE_HANDBOOK` | **yes** | `api[_-]?key\s*[=:]\s*\S{8,}` |

**Probe (realistic extra):**

| Text | TS=PY | Rule |
| --- | --- | --- |
| YAML `from:` + `date:` | deny | `looks_like_mail` |
| `Date: Tuesday` + `Subject: tomorrow's plan` | deny | `looks_like_mail` |
| `Password: rotate quarterly` | deny | `password\s*:` |
| `We talked about brokerage fees yesterday.` | deny | `\bbrokerage\b` |
| `the tax-lot method is FIFO` | deny | `\btax-lots?\b` |
| `To: the point of the meeting` + `Date: Tuesday` | deny | `looks_like_mail` |

HEAD `box-export.py` skipped the same denied notes (`benign exported 43/45`; positives exported **[]**).

**Positive corpus (all caught by both sides):** mail From+Subject, To+Date, Received+Message-ID, Cc+Bcc, Reply-To+Return-Path; `password:`; `api_key=`; SSN `000-00-0000`; `555.010.0199`; `+1 555 010 0199`; `9 Example Place`; `holdings` in body; hyphen phone; `ada@example.com`; `9 Example Road`.

## DST / age (D)

`stampFresh`: `age = now.getTime() - Date.parse(value)` vs `maxAgeHours * 3600 * 1000` (`multi-account.ts:178-187`). That is **UTC milliseconds**, not NY wall-clock. Injected `now` via `runLoader`. Stamps were valid `isNewYorkExportTime` values.

| Case | stamp | now | stale? |
| --- | --- | --- | --- |
| exact 36h past | `2026-11-10T19:00:00-05:00` | `2026-11-12T12:00:00.000Z` | no |
| 36h−1s past | `…19:00:01-05:00` | same | no |
| 36h+1s past | `…18:59:59-05:00` | same | **yes** |
| exact 36h future | `2026-11-13T19:00:00-05:00` | same | no |
| 36h−1s future | `…18:59:59-05:00` | same | no |
| 36h+1s future | `…19:00:01-05:00` | same | **yes** |
| fall-back 24h abs | `2026-11-01T02:00:00-05:00` | `2026-11-02T07:00:00.000Z` | no |
| fall-back exact 36h | `2026-10-31T15:00:00-04:00` | same | no |
| fall-back 36h+1s | `2026-10-31T14:59:59-04:00` | same | **yes** |
| fall-back 25h abs (25h wall possible) | `2026-11-01T01:00:00-05:00` | same | no |
| spring 24h | `2026-03-07T03:00:00-05:00` | `2026-03-08T08:00:00.000Z` | no |
| spring exact 36h | `2026-03-06T15:00:00-05:00` | same | no |
| spring 36h+1s | `2026-03-06T14:59:59-05:00` | same | **yes** |
| missing `box_export_max_age_hours` | 36h+1s past stamp | `2026-11-12T12:00:00.000Z` | **stale**; `loadConfig` → `boxExportMaxAgeHours === 36` (`config.ts:330`) |

Future skew on the **drop** is symmetric ±36h inclusive. Fail-closed `EXPORTED_AT` is different: `fail-closed.ts:91` is `now - when > window` only (future stamps are accepted). That is the #4 contract, not this drop.

## Mutations (E)

Copy under `/tmp/qa-mut/work` only. Official `bun test` those two files + `python3 scripts/bot-loader/test_secret_rules.py`.

| Mutation | bun | python | Discriminating fail |
| --- | --- | --- | --- |
| size check off | 50/1 | OK | `a size mismatch is skipped when the sha256 still matches` |
| mail-header off TS | 49/2 | OK | `a mail-shaped note rejects the bot folder` (+ export-time deny expects) |
| mail-header off PY | 49/2 | FAILED 1 | Python `From:\nSubject:`; exporter still copied `notes/body.md` |
| `--fail-closed` writes per-bot | 49/2 | OK | `box export writes a per-bot manifest…`; `a fail-closed export is accepted…` |
| unknown-key reject off | 50/1 | OK | `an unknown manifest key imports nothing…` |
| stale check off | 50/1 | OK | `a stamp outside the age window imports nothing` |
| missing → `hash mismatch` | 50/1 | OK | `a listed file that is gone logs missing` |
| drop `password:` | 49/2 | FAILED 1 | `password: not-a-real-value` |
| drop `api_key=` | 49/2 | FAILED 1 | `api_key=` |
| drop SSN | 49/2 | FAILED 1 | `000-00-0000` |
| drop dotted phone | 49/2 | FAILED 1 | `555.010.0199` |
| drop +1 phone | 49/2 | FAILED 1 | `+1 555 010 0199` |
| drop Place | 49/2 | FAILED 1 | `9 Example Place` |
| drop `\bholdings\b` | 49/2 | FAILED 1 | `The holdings list stays offline.` |

## r1 strengths (G)

Re-run on HEAD: file symlink (canary `outside canary` never ingested), `../outside.md` → `path escape`, mid-run `manifest.json` swap → `manifest changed` / 0 puts, second run `written=0` `unchanged=5`, deleting the bot folder → summary matches `/orphan/i` and `pages-a/.../memory.md` still on disk, `account` mismatch → skip / 0 puts.

## Privacy (H)

`git diff -U0 origin/grok...HEAD` added lines: **0** `<BUSINESS-HANDLE>`, **0** private IPv4, **0** token-shaped prefixes. One added line in `pr5-build-qa-r1.md` cites synthetic `ada@example.com` and documents “No `/home/…` or `/Users/…`”. Tests still concatenate `555`+`010`+`0199`. `config.example.json` uses `<EXPORT-ROOT>` / `<ACCOUNT-B>`. `<BUSINESS-HANDLE>` does **not** appear in any **added** line; remaining uses are grok-context in unchanged fail-closed tests (`test/bot-loader.test.ts`).

## Findings

1. **Low** — GitHub PR #5 body “Tests” block vs `bun test` output. Body says `631 expect() calls`; command printed `630 expect() calls` (`51 pass, 0 fail`). Fix: set the body to 630 (or re-run and paste the new total).

2. **Low** — `scripts/bot-loader/export-deny.ts:39-45`, `export_deny.py:50-57`, `export-deny.json:29`. Two header-shaped lines in the first 20 lines deny the file. That matches the mail fix, but it also denies ordinary YAML `from:`+`date:` front matter and meeting notes that are only `Date:` + `Subject:` with no address. Single `Subject:` and `From the hill` still pass. Fix: require an address-like value, ignore YAML between `---`, or drop `Date`/`From`/`To` unless they look like RFC 822.

3. **Low** — `export-deny.json:25-26` (`\bbrokerage\b`, `\btax-lots?\b`). `We talked about brokerage fees yesterday.` and `the tax-lot method is FIFO` are denied on both TS and Python. The claimed holdings narrowing was `\bholdings\b` vs `holding pattern`. Fix: drop those two, or require finance context (filename / table), not the English words.

4. **Low** — `export-deny.json:23`. Fenced `api_key: SEE_HANDBOOK` is denied (`\S{8,}` after `:`). Claimed negative was `The api key is rotated quarterly.` Fix: require assignment without a space-separated handbook word, or skip fenced examples.

## Could not check

- Docker / `bun run test:e2e` / `bun run ci:local`.
- Live share mounts or real account drops (synthetic `/tmp` only).
- Windows path semantics.
- `libfaketime` (unavailable); producers happened to share the same UTC second; only `EXPORTED_AT` count and MANIFEST membership were normalized/compared beyond that.
- Full-tree `bun test` (not requested; r1 saw pre-existing red on grok and HEAD).
- Independent model family (same review setup as r1).

