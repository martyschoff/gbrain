# gbrain PR #5 build QA r4

- Head checked: 71b592abbdb3da726ebc61a13d6211de78eab16b (branch feature/multi-account-bot-export; base grok at 5eb8b994)
- Reviewer: CloudQA via Cursor cloud agent bc-06b11d06, model grok-4.6 (effort medium). Same model family as the grok-4.7 builder, so this is not an independent-family check.
- Read-only review with synthetic fixtures only.

## CloudQA verdict: FAIL, 1 Low

The cloud reviewer's report (below) says PASS with no findings. I'm overriding it based on its own corpus table: a pasted mail header block with one title line above it is still exported. All three r3 fixes hold: tests 52/0/697 (matches the PR body), python 3 OK, typecheck 0, 14/14 mutations caught, --fail-closed parity holds with only deny-list drops, the r1/r2 behaviours hold, and privacy is clean.

### Finding

1. **Low**: `scripts/bot-loader/export-deny.ts` `contiguousHeaderBlock` / `looksLikeMail`, and `scripts/bot-loader/export_deny.py` `_contiguous_header_block` / `looks_like_mail`. The 3-header block only counts at the very top of the note. The corpus cases `after-title` (`Invoice follow-up` then `From: Ada Lovelace` / `Subject: Re: invoice` / `Date: Tuesday`) and `after-title-and-blank` are exported by `box-export.py` in both TS and Python. A note with a heading or one line of context above a pasted email is the usual way mail gets pasted into notes, so this re-opens a narrow part of r1 Medium 2. **Fix:** count a run of >=3 contiguous header lines starting anywhere in the scan window (outside a leading closed YAML block), not only at line 1. Optionally also accept leading whitespace or a `> ` quote prefix. Pin `after-title` and `after-title-and-blank` as denied and not exported, and keep the `md-table-from-to`, `from-ada-subject-two`, `date-subject-meeting`, `to-date` and YAML negatives passing. Add a mutation proof (anchor back to the top makes a test fail). The `indented-headers`, `wrote-split`, empty-`Date:` and German-header cases are observations only, not required for PASS.

---

## Cloud reviewer report (verbatim)

Verdict: PASS

Reviewer is grok-4.6 (same family as the grok-4.7 builder; not an independent-family check). Read-only. `git rev-parse HEAD` = `71b592abbdb3da726ebc61a13d6211de78eab16b`. PR is [martyschoff/gbrain#5](https://github.com/martyschoff/gbrain/pull/5) (base `grok`). After `git fetch origin grok`, `origin/grok` = `5eb8b994b85f59efa44c37858448826821c8f2c0`. r3 head `604af40191e6cfd22ec5b671ed55bcf8a73bf93a` is an ancestor. Synthetic `/tmp` fixtures only.

## What ran

| Command | Claim (PR body / builder) | Actual |
| --- | --- | --- |
| `git rev-parse HEAD` | `71b592abb…` | `71b592abbdb3da726ebc61a13d6211de78eab16b` |
| GitHub PR #5 Tests block (`get_pull_request` on `martyschoff/gbrain`) | 52 pass / 0 fail / 697 `expect()`; python 3 OK; typecheck exit 0 | Body text is exactly that. (`garrytan/gbrain` #5 is a different, closed OpenClaw plugin PR.) |
| `git diff --stat 604af401..HEAD` | r3→HEAD | 9 files, **+442 / −36** |
| `git diff --stat origin/grok...HEAD` | PR vs grok | 20 files, **+2762 / −112**. All under `docs/grok/bot-loader`, `scripts/bot-loader`, `test/bot-loader*.ts`. `fail-closed.ts` is not in the diff. |
| `python3 scripts/bot-loader/test_secret_rules.py` | 3 tests, OK | Exit **0**. `Ran 3 tests in 0.001s` / `OK` |
| `bun test --timeout=60000 test/bot-loader-multi-account.test.ts test/bot-loader.test.ts` | 52 / 0 / 697 | Exit **0**. **52 pass / 0 fail / 697 expect() calls**. Ran 52 tests across 2 files. [3.31s] |
| `bun run typecheck` | exit 0 | Script is `node --max-old-space-size=12288 node_modules.typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile node_modules/.cache/gbrain-typecheck.tsbuildinfo`. Exit **0**. |
| TS+PY+exporter corpus (39 cases) | six address-less denied; placeholders kept; YAML/meeting negatives kept | **0 TS/Python disagreements**. Claimed six (with a Date value) denied and not exported. |
| `/tmp` mutations | each ≥1 fail | **14/14** failed ≥1 official test (see D). |
| grok `box-export.py` vs HEAD `--fail-closed --source acme-biz --account acme-biz` | deny-list drops only | Same UTC stamp `2026-11-12T23:56:03Z`. Shared payloads byte-identical. HEAD dropped `holdings.md`, `password.md`, and address-less `mail.md`. |
| HEAD `checkFailClosed` + `runLoader` | mail not ingested | grok tree: `ok=false skip=finance-data`, puts `[]`. HEAD: `ok=true` 5 files, no `mail.md`, loader exit 0. |

## A. Diff / merge

`604af401..HEAD`: `docs/grok/bot-loader/qa/pr5-build-qa-r3.md`, `export-deny.json`, `export-deny.ts`, `export_deny.py`, `secret-patterns.json`, `secret_rules.py`, `secrets.ts`, `test_secret_rules.py`, `test/bot-loader-multi-account.test.ts`.

Merge `71b592abb` parents: `88db7dc21` + `a68ebd236` (`Merge remote-tracking branch 'origin/feature/multi-account-bot-export'`). No `mail_other_headers` leftover. One JSON contract: `mail_headers` + `mail_address_headers` + `mail_strong_headers` + `mail_block_headers` + `mail_markers` + `key_assignment`. TS (`looksLikeMail` / `contiguousHeaderBlock` / `mailLines` / `placeholderSecret`) and Python (`looks_like_mail` / `_contiguous_header_block` / `_mail_lines` / `placeholder_secret`) implement the same rules. `secret_rules.py` and `secrets.ts` both apply the placeholder allowlist to `api_key` / `access_token` `=` and `:` forms via `allow_placeholders` in `secret-patterns.json`. No `<<<<<<<` in bot-loader sources or the two test files (the token appears only in older QA prose).

## r3 claimed fixes

| # | Claim | Status |
| --- | --- | --- |
| 1 Medium address-less mail | keep `@` rule; also deny ≥3 contiguous top headers, Original Message, Gmail Forwarded, `On <date>, <name> wrote:`; six fixtures denied in TS/Python and absent from exporter; YAML `from:`+`date:`, Date+Subject, To+Date stay allowed | **Holds** on the pinned fixtures (Date with a value). See corpus. |
| 2 Low YAML / unclosed `---` | only a leading closed `---` block is ignored; Message-ID+Received inside a closed fence and after an unclosed `---` are denied; `yaml-ignore-off` fails a test | **Holds.** Closed and unclosed Message-ID fixtures denied. `yaml-ignore-off` → python FAIL + bun 50/2. |
| 3 Low placeholders | allowlist applies to `=` and `:` in `secret_rules.py` and `secrets.ts`; exporter tests cover both; real-looking keys still denied | **Holds.** `api_key=YOUR_KEY_HERE` / `xxxxxxxx` / `EXAMPLE*` / ALLCAPS and colon `YOUR_*` / `SEE_VAULT` / `<redacted>` export; `not-a-real-value` and mixed alnum denied. |
| Tests | PR body 52/0/697 | **Matches** bun output. |

## C. Corpus

TS = `deniedExportContent` / `looksLikeMail` / `contentHasSecret`. PY = `denied_content` / `looks_like_mail` / `secret_content`. Exporter = HEAD `box-export.py` per-bot notes `note00.md`… (`denied_name` does not fire). **No TS/PY disagreement.** Exporter stdout: `bot bot-a files=26 secrets_skipped=16`.

| id | group | TS denied | PY denied | TS mail | PY mail | exported |
| --- | --- | --- | --- | --- | --- | --- |
| addrless-ada-invoice (`Date: Tuesday`) | six | y | y | y | y | no |
| addrless-outlook | six | y | y | y | y | no |
| addrless-original | six | y | y | y | y | no |
| addrless-gmail-fwd | six | y | y | y | y | no |
| addrless-on-wrote | six | y | y | y | y | no |
| addrless-from-to-subject-date | six | y | y | y | y | no |
| crlf-headers | variant | y | y | y | y | no |
| after-1-blank / after-2-blank | variant | y | y | y | y | no |
| lowercase-keys | variant | y | y | y | y | no |
| addrless-ada-invoice-empty-date (`Date:`) | variant | n | n | n | n | **yes** (empty value is not a header; run stops at 2) |
| indented-headers | variant | n | n | n | n | **yes** (`^` does not match indent) |
| after-title / after-title-and-blank | variant | n | n | n | n | **yes** (not “at the top”) |
| wrote-split | variant | n | n | n | n | **yes** (marker is one line) |
| de-von-an-betreff | observation | n | n | n | n | **yes** (Von/An/Betreff not in the English header list) |
| yaml-from-date | benign | n | n | n | n | yes |
| yaml-from-subject-date | benign | n | n | n | n | yes |
| date-subject-meeting | benign | n | n | n | n | yes |
| to-date | benign | n | n | n | n | yes |
| md-table-from-to | benign | n | n | n | n | yes |
| from-ada-subject-two | benign | n | n | n | n | yes |
| prose-wrote | benign | n | n | n | n | yes |
| brokerage-fees / tax-lot-method | benign | n | n | n | n | yes |
| fenced-api-key-see | benign | n | n | n | n | yes |
| ph-your-eq / ph-xxx-eq / ph-example-eq / ph-allcaps-eq | placeholder | n | n | n | n | yes |
| ph-your-colon / ph-redacted-colon / ph-see-vault | placeholder | n | n | n | n | yes |
| real-mixed (32+ mixed alnum) | key | y | y | n | n | no |
| not-a-real-value | key | y | y | n | n | no |
| yaml-closed-msgid / yaml-unclosed-msgid | yaml | y | y | y | y | no |
| yaml-email-in-fence | yaml | y | y | n | n | no (email content regex; mail scan skipped) |
| yaml-email-body | yaml | y | y | y | y | no |

No benign false positive on the required keep-list. No leak of the six pinned address-less fixtures.

## D. Mutations

Copy `/tmp/qa-mut/work` only. Official bun pair + `python3 scripts/bot-loader/test_secret_rules.py`.

| Mutation | bun | python | Discriminating fail |
| --- | --- | --- | --- |
| block-off (3-header) | 48/4 | FAIL 1 | `From: Ada Example` + `Subject:` + `Date: Thursday`; exporter `invoice.md` / `headers.md` |
| original-off | 49/3 | FAIL 1 | `-----Original Message-----` |
| forward-off | 49/3 | FAIL 1 | `---------- Forwarded message ---------` |
| wrote-off | 49/3 | FAIL 1 | `On Thursday, 12 Nov 2026, Ada Example wrote:` |
| yaml-ignore-off | 50/2 | FAIL 1 | YAML `from:`/`subject:`/`date:` now denied |
| unclosed-fence-hides (hide rest, including Message-ID) | 50/2 | FAIL 1 | unclosed `---` + `Received` + `Message-ID: <fake.1>` |
| placeholder-off-py (`secret_rules.py`) | 49/3 | FAIL 1 | `api_key=YOUR_KEY_HERE`; exporter placeholder notes |
| placeholder-off-ts (`secrets.ts`) | 50/2 | OK | `contentHasSecret('api_key=YOUR_KEY_HERE')`; ingest of exporter drop |
| size-check-off | 51/1 | OK | `a size mismatch is skipped when the sha256 still matches` |
| unknown-key-off | 51/1 | OK | `an unknown manifest key imports nothing from that folder` |
| stale-off | 51/1 | OK | `a stamp outside the age window imports nothing` |
| missing → `hash mismatch` | 51/1 | OK | `a listed file that is gone logs missing` |
| `--fail-closed` → `export_tree` | 50/2 | OK | `box export writes a per-bot manifest…`; `a fail-closed export is accepted…` |
| brokerage re-add | 50/2 | FAIL 1 | `We talked about brokerage fees yesterday.` |

## E. `--fail-closed` parity

PR #4 / grok producer: `git show origin/grok:scripts/bot-loader/box-export.py` with grok `secret_rules.py` + `secret-patterns.json`, `--account acme-biz --source acme-biz`. HEAD: `box-export.py --fail-closed --source acme-biz --account acme-biz`. Same synthetic agent. No faketime; both stamps `2026-11-12T23:56:03Z`.

**Identical:** layout `example-bot/{profile.json,memory/profile.md,memory/log/*.md,attachments/*}`; MANIFEST key order `version, account, source, exported_at, files, file_count, byte_count`; `json.dumps(..., indent=2)+"\n"`; lowercase hex; file mode `0644`; dirs `0755` (temp root `0700` both). Five shared file payloads **byte-equal** (`profile.json`, `memory/profile.md`, `memory/log/2026-11-12.md`, `attachments/note.txt`, `attachments/placeholder.md`).

**Differences (deny-list drops + counts only):**

| Path | grok | HEAD |
| --- | --- | --- |
| `attachments/holdings.md` | present | omitted (`\bholdings\b`) |
| `attachments/password.md` | present | omitted (`password:` + secret-patterns) |
| `attachments/mail.md` | present (From+Subject+Date, no `@`) | **omitted** (`looks_like_mail` 3-header block) |
| `EXPORTED_AT` line 2 | `example-bot 8` | `example-bot 5` |
| MANIFEST `file_count` / `byte_count` | 8 / 243 | 5 / 97 |
| stdout | `files=8 secrets_skipped=0` | `files=5 secrets_skipped=3` |

`checkFailClosed` on grok tree: **`finance-data`** (holdings filename); loader exit 0, `SKIP acme-biz: finance-data`, no puts, no mail on disk. HEAD tree accepted (`note.txt`, `placeholder.md`, memory, profile); loader wrote those five slugs; **mail was not ingested**.

## F. r1/r2 behaviours (official tests)

HEAD bun pair passed: size mismatch; `--source` without `--fail-closed` refused; `--fail-closed` signed tree accepted; symlink + path escape; mid-run manifest swap; second run `written=0` `unchanged=5`; orphans; account mismatch; stamp outside 36h → `stale`.

## G. Privacy

`git diff -U0 origin/grok...HEAD` added lines: emails only `ada@example.com`. `1.2.3.4` / `10.30.2026` are QA corpus strings. `/Users/` and `<BUSINESS-HANDLE>` appear only as “none found” prose in QA docs. No token-shaped prefixes. Names are synthetic (`Ada Lovelace` in the r3 record, `Ada Example` / `Quinn Example` / `Pat Example` in tests). Tests still concatenate `555`+`010`+`0199`.

## Findings

None.

## Could not check

- Docker / `bun run test:e2e` / `bun run ci:local` / full `bun test`.
- Live share mounts or real account drops.
- Windows path semantics.
- `libfaketime` (producers shared the same UTC second without it).
- Independent model family (same family as the builder).
- Non-English mail beyond the Von/An/Betreff observation.

