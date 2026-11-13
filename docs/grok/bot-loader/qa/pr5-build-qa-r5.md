# gbrain PR #5 build QA r5

- Head checked: 7b79891c8a2eb7d341e64afa377dc6e96bbcb413 (branch feature/multi-account-bot-export; base grok at 5eb8b994)
- Reviewer: CloudQA via Cursor cloud agent bc-e6428e75, model grok-4.6 (effort medium). Same model family as the grok-4.7 builder, so this is not an independent-family check.
- Read-only review with synthetic fixtures only.
- CloudQA note: I agree with the FAIL (1 Low). The new false positives (a 3-line From/To/Date travel note and a Date/Subject/To meeting template) are accepted as fail-safe, matching the r4 rule at line 1. They are an observation, not a finding.

Verdict: FAIL

Reviewer is grok-4.6 (same family as the grok-4.7 builder; not an independent-family check). Read-only. `git rev-parse HEAD` = `7b79891c8a2eb7d341e64afa377dc6e96bbcb413` (detached, matches expected). PR is [martyschoff/gbrain#5](https://github.com/martyschoff/gbrain/pull/5) (base `grok`). After `git fetch origin grok`, `origin/grok` = `5eb8b994b85f59efa44c37858448826821c8f2c0` (same as the GitHub PR base). The parallel titled-header fix is `8ae008470` (`Deny a mail header block under a title.`), merged as `HEAD^2`; it is not `origin/grok`. r4 head `71b592abbdb3da726ebc61a13d6211de78eab16b` is an ancestor. Synthetic `/tmp` fixtures only.

## What ran

| Command | Claim (PR body / builder) | Actual |
| --- | --- | --- |
| `git rev-parse HEAD` | `7b79891c8a2eb7d341e64afa377dc6e96bbcb413` | match |
| GitHub PR #5 Tests block | 52 pass / 0 fail / 704 `expect()`; python 3 OK; typecheck 0 | Body text is exactly that |
| `git diff --stat 71b592ab..HEAD` | r4→HEAD titled-header fix | 5 files, **+186 / −16** |
| `git diff --stat origin/grok...HEAD` | PR vs grok | 21 files, **+2932 / −112** (matches GitHub `additions: 2932`) |
| `python3 scripts/bot-loader/test_secret_rules.py` | 3 tests, OK | Exit **0**. `Ran 3 tests in 0.002s` / `OK` |
| `bun test --timeout=60000 test/bot-loader-multi-account.test.ts test/bot-loader.test.ts` | 52 / 0 / 704 | Exit **0**. **52 pass / 0 fail / 704 expect()**. Ran 52 tests across 2 files. [3.61s] |
| `bun run typecheck` | exit 0 | `node --max-old-space-size=12288 node_modules/typescript/bin/tsc --noEmit --incremental --tsBuildInfoFile node_modules/.cache/gbrain-typecheck.tsbuildinfo`. Exit **0** |
| TS+PY+exporter corpus | after-title denied; six r3 denied; keep-list exported | **0 TS/Python disagreements**. Exporter `bot bot-a files=20 secrets_skipped=18` |
| `/tmp` mutations vs official bun pair + python | each ≥1 fail | **18/20** failed ≥1 official test. **quote-prefix-off** and **whitespace-strip-off** stayed **52/0 + python OK** (see D and Findings) |
| grok producer vs HEAD `--fail-closed --source acme-biz --account acme-biz` | deny-list drops only | Same UTC stamp `2026-11-13T00:08:20Z`. Shared payloads byte-identical. HEAD dropped holdings, password, titled address-less mail |
| HEAD `checkFailClosed` + `runLoader` | mail not ingested | HEAD: `ok=true`, 5 files, **MAIL_PUTS 0**. grok tree: `ok=false skip=finance-data` |

## A. Diff / merge

`71b592ab..HEAD`: `docs/grok/bot-loader/qa/pr5-build-qa-r4.md`, `export-deny.ts`, `export_deny.py`, `test_secret_rules.py`, `test/bot-loader-multi-account.test.ts`.

Merge `7b79891c8` parents: `e83c49e55` (local titled-header reset-anywhere) + `8ae008470` (origin parallel titled-header fix with `headerCandidate`). HEAD kept **one** pair: `contiguousHeaderBlock` / `_contiguous_header_block`, plus `headerCandidate` / `_header_candidate`. Origin’s extra empty/`---` special-case was dropped because a non-header already resets `run` to 0. No second helper, no `mail_other_headers` leftover. `fail-closed.ts` is not in the PR diff.

TS and Python implement the same rules: scan window `mail_scan_lines` **20**; `mail_block_min` **3**; reset on a non-header instead of stopping; strip leading whitespace and `(?:>\s*)+` before the block regex (the block regex still also allows optional indent and one `>`). A leading closed `---` is skipped except Message-ID/Received. No `<<<<<<<` in `scripts/bot-loader` or the two test files (the token appears only in older QA prose).

## B. Commands vs claims

Builder and PR body match the runs above (704, not r4’s 697).

## C. Corpus

TS = `deniedExportContent` / `looksLikeMail` (plus `contentHasSecret` for keys). PY = `denied_content` / `looks_like_mail` (plus `secret_content`). Exporter = HEAD `box-export.py` per-bot `notes/n01.md`… (`denied_name` does not fire). **No TS/PY disagreement.** Window size: **20** visible lines (`export-deny.json` `mail_scan_lines`).

| id | expect | TS denied | PY denied | TS mail | PY mail | exported |
| --- | --- | --- | --- | --- | --- | --- |
| after-title (`Invoice follow-up` + Ada Lovelace From/Subject/Date) | deny | y | y | y | y | no |
| after-title-and-blank | deny | y | y | y | y | no |
| addrless-ada-invoice | deny | y | y | y | y | no |
| addrless-outlook | deny | y | y | y | y | no |
| addrless-original | deny | y | y | y | y | no |
| addrless-gmail-fwd | deny | y | y | y | y | no |
| addrless-on-wrote | deny | y | y | y | y | no |
| addrless-from-to-subject-date | deny | y | y | y | y | no |
| mid-long-note (8 pad lines then 3 headers) | deny | y | y | y | y | no |
| quoted-headers (`> `) | deny | y | y | y | y | no |
| indented-headers | deny | y | y | y | y | no |
| crlf-headers | deny | y | y | y | y | no |
| yaml-closed-msgid / yaml-unclosed-msgid | deny | y | y | y | y | no |
| yaml-from-date-to-subject | keep | n | n | n | n | yes |
| date-subject-meeting | keep | n | n | n | n | yes |
| to-date | keep | n | n | n | n | yes |
| md-table-from-to | keep | n | n | n | n | yes |
| from-ada-subject-two | keep | n | n | n | n | yes |
| prose-wrote | keep | n | n | n | n | yes |
| brokerage-fees / tax-lot-method | keep | n | n | n | n | yes |
| fenced `api_key: SEE_HANDBOOK` | keep | n | n | n | n | yes |
| ph YOUR_KEY_HERE / xxxxxxxx / `<redacted>` / SEE_VAULT | keep | n | n | n | n | yes |
| real mixed alnum / `not-a-real-value` | deny | y | y | n | n | no |
| **fp-travel** `From: City A` / `To: City B` / `Date: Friday` | new | **y** | **y** | y | y | **no** |
| **fp-meeting-template** `Date: Monday` / `Subject: Planning` / `To: team` | new | **y** | **y** | y | y | **no** |
| three headers with a blank between each | keep | n | n | n | n | yes |
| two headers, prose, two more | keep | n | n | n | n | yes |
| md list `- From:` / `- To:` / `- Date:` | keep | n | n | n | n | yes |
| 3 headers **after** 20 padding lines | keep | n | n | n | n | yes |

**False-positive judgement:** travel and meeting-template 3-liners are realistic notes, but they are the same 3-header heuristic that r4 already applied at line 1. Reset-anywhere newly drops them under a title; blank-separated, split pairs, lists, and a 2-header Date+Subject still export. That is **acceptable fail-safe**, not a finding.

## D. Mutations (`/tmp/qa-mut/work` only)

Official `python3 scripts/bot-loader/test_secret_rules.py` + the bun pair.

| Mutation | bun | python | Discriminating fail |
| --- | --- | --- | --- |
| top-only-stop TS | 51/1 | OK | titled `Invoice follow-up` expects in the NY-stamp/deny test |
| top-only-stop PY | 50/2 | FAIL 1 | same titled fixtures; exporter `titled.md` |
| reset-to-stop TS only | 51/1 | OK | titled expects (parallel TS tests, not a shared TS/PY comparator) |
| reset-to-stop PY only | 50/2 | FAIL 1 | python + exporter titled notes |
| block min 3→4 | 48/4 | FAIL 1 | 3-header Ada/From/Subject/Date |
| Original marker off | 49/3 | FAIL 1 | `-----Original Message-----` |
| Forwarded marker off | 50/2 | FAIL 1 | `---------- Forwarded message ---------` (3-header Gmail body still denied) |
| wrote: marker off | 49/3 | FAIL 1 | `On … wrote:` |
| yaml-ignore-off | 50/2 | FAIL 1 | YAML `from:`/`subject:`/`date:` now denied |
| unclosed-fence-hides (incl. Message-ID) | 50/2 | FAIL 1 | unclosed `---` + Received + Message-ID (a weaker mutation that still let strong headers through did **not** fail; hiding strong headers did) |
| placeholder-off PY | 49/3 | FAIL 1 | `api_key=YOUR_KEY_HERE`; exporter placeholder notes |
| placeholder-off TS | 50/2 | OK | `contentHasSecret('api_key=YOUR_KEY_HERE')`; ingest of exporter drop |
| size-check-off | 51/1 | OK | `a size mismatch is skipped when the sha256 still matches` |
| unknown-key-off | 51/1 | OK | `an unknown manifest key imports nothing from that folder` |
| stale-off | 51/1 | OK | `a stamp outside the age window imports nothing` |
| missing → `hash mismatch` | 51/1 | OK | `a listed file that is gone logs missing` |
| `--fail-closed` → `export_tree` | 50/2 | OK | per-bot manifest / fail-closed reader tests |
| brokerage re-add | 50/2 | FAIL 1 | `We talked about brokerage fees yesterday.` |
| **quote-prefix strip off** (candidate + regex `>`) | **52/0** | **OK** | **none.** Quoted 3-header corpus then exports (`looksLikeMail` false) |
| **whitespace strip off** (no `trim`/`strip`, no leading `[ \t]*` on the block regex) | **52/0** | **OK** | **none.** Indented 3-header corpus then exports |

## E. `--fail-closed` parity

Grok producer: `git show origin/grok:scripts/bot-loader/box-export.py` with grok `secret_rules.py` + `secret-patterns.json`, `--account acme-biz --source acme-biz` (grok has no `--fail-closed` flag). HEAD: `box-export.py --fail-closed --source acme-biz --account acme-biz`. Same synthetic `example-bot`. No faketime; both stamps `2026-11-13T00:08:20Z`.

**Identical:** layout `example-bot/{profile.json,memory/profile.md,memory/log/*.md,attachments/*}`; MANIFEST key order `version, account, source, exported_at, files, file_count, byte_count`; `json.dumps(..., indent=2)+"\n"`; lowercase hex; file mode `0644`; dirs `0755`; temp root `0700`. Five shared payloads **byte-equal**.

**Differences (deny-list drops + counts only):**

| Path | grok | HEAD |
| --- | --- | --- |
| `attachments/holdings.md` | present | omitted (`\bholdings\b`) |
| `attachments/password.md` | present | omitted (`password:` + secret-patterns) |
| `attachments/mail.md` (titled address-less) | present | **omitted** (3-header block anywhere) |
| `EXPORTED_AT` line 2 | `example-bot 8` | `example-bot 5` |
| MANIFEST `file_count` / `byte_count` | 8 / 232 | 5 / 97 |
| stdout | `files=8 secrets_skipped=0` | `files=5 secrets_skipped=3` |

`checkFailClosed` on grok tree: **`finance-data`**; loader exit 0, `SKIP acme-biz: finance-data`, no puts. HEAD tree accepted; loader wrote five slugs; **mail was not ingested**.

## F. r1/r2 behaviours (official tests)

HEAD bun pair passed: size mismatch; `--source` without `--fail-closed` refused (inside `box export writes a per-bot manifest…`); symlink + path escape; mid-run manifest swap; second run `written=0` `unchanged=5`; orphans; account mismatch; stamp outside 36h → `stale`.

## G. Privacy

`git diff -U0 origin/grok...HEAD` added lines: emails only `ada@example.com`. `1.2.3.4` / `10.30.2026` are QA corpus strings. `/Users/` and `<BUSINESS-HANDLE>` appear only as “none found” prose in QA docs. No token-shaped prefixes. Names are synthetic (`Ada Lovelace`, `Ada Example`, `Quinn Example`, `Pat Example`). Tests still concatenate `555`+`010`+`0199`.

## Findings

1. **Low** — `test/bot-loader-multi-account.test.ts` and `scripts/bot-loader/test_secret_rules.py` (missing fixtures), relative to `scripts/bot-loader/export-deny.ts` `headerCandidate` / `BLOCK_LINE` (~126–140) and `scripts/bot-loader/export_deny.py` `_header_candidate` / `_BLOCK_LINE` (~134–151). Quoted (`> `) and indented 3-header blocks are denied on HEAD (corpus), but turning off quote-prefix strip or leading-whitespace strip does **not** fail the official bun pair or python tests (still 52/0 and 3 OK). The claimed strip is therefore not mutation-pinned. **Fix:** add the quoted and indented Ada/From/Subject/Date notes as denied (and not exported) next to after-title; a mutation that restores top-only stop should keep failing those titled cases, and a mutation that removes `>` / indent handling should fail the new ones.

## Could not check

- Docker / `bun run test:e2e` / `bun run ci:local` / full `bun test`.
- Live share mounts or real account drops.
- Windows path semantics.
- `libfaketime` (producers shared the same UTC second without it).
- Independent model family (same family as the builder).
- Non-English mail headers.

