# gbrain PR #5 build QA, round 1: FAIL

- PR: https://github.com/martyschoff/gbrain/pull/5
- Head checked: 1984702dfc70b0ab2ef737c651171cf2b3233173 (base origin/grok c1080d1f9 at review time)
- Reviewer: CloudQA via Cursor cloud agent bc-6cb8ad86, model grok-4.6, effort medium (read-only; same model family as the grok-4.7 builder, so not an independent-family check)
- Date: 12 Nov 2026 (ET)
- Result: FAIL, 3 Medium, 5 Low.

---

Verdict: FAIL

Read-only review of `1984702dfc70b0ab2ef737c651171cf2b3233173` vs `origin/grok` (`c1080d1f9`). Experiments used `/tmp` copies only; the original checkout was not modified.

## What ran

| Command | Claim | Actual |
| --- | --- | --- |
| `git diff --stat origin/grok...HEAD` | PR surface | 13 files, **+1492 / −150**. Merge-base is `c1080d1f9` (HEAD is one commit on top of current `grok`). |
| `python3 test_secret_rules.py` (HEAD copy) | 3 OK | Exit **0**. `Ran 3 tests … OK`. |
| `bun test test/bot-loader-multi-account.test.ts` (HEAD) | part of 45/0, 571 expects | Exit **0**. **11 pass / 0 fail / 77 expects**. |
| `bun test test/bot-loader.test.ts` (HEAD) | rest of 45/0 + #4 feeds | Exit **0**. **34 pass / 0 fail / 494 expects**. **11+34=45, 77+494=571**. Matches the claim. |
| `bun test test/bot-loader.test.ts` (base `origin/grok`) | #4 suite still green | Exit **0**. **34 pass / 0 fail / 485 expects**. |
| `/tmp/qa-bot-export/adversarial.test.ts` | extra fixtures | Exit **0**. **18 pass / 0 fail / 102 expects**. |
| `python3 box-export.py` synthetic drop | documented layout, denials, no abs paths | Exit **0**. `files=7 secrets_skipped=9`. No tree `MANIFEST.json` / `EXPORTED_AT`. |
| Size-check mutation vs official 45 tests | should fail ≥1 | Exit **0**. **45 pass / 0 fail**. Missing test. |
| sha / account / symlink / content-secret mutations | should fail ≥1 each | Each **1 fail / 44 pass**. |
| Fail-closed stamp-root guard mutation | should fail ≥1 | **1 fail** (`fail-closed stamp_root` case). |
| Revert `run.ts` to grok, run new file | builder: **1/10 fail** | **1 pass / 10 fail** (export-time test only). Claim is wrong. |
| `bun run typecheck` (6GB) HEAD and base | may OOM | Both **SIGABRT / exit 134**, heap OOM at ~6GB. |
| `NODE_OPTIONS=--max-old-space-size=12288` tsc | retry | HEAD **0**, base **0**. Same OOM-at-6GB on both. |
| `bun test` full tree HEAD | full suite | Exit **1**. **11465 pass / 284 fail / 4 timeouts** (native `bun test`, not `bun run test`). |
| `bun test` full tree base | compare | Exit **1**. **11464 pass / 285 fail / 4 timeouts**. Fail-file set is the same except base also failed `test/sync-working-stat-cache-6712.test.ts`. No new full-suite fail files on HEAD. |

## 1. Diff and review

`origin/grok...HEAD`: docs README + `multi-account-export.md`; `box-export.py` rewritten to per-bot folders; `config.ts` `export_roots` + stamp overlap guard; `export-deny.json` / `.ts` / `.py`; `multi-account.ts` planner; `render.ts` account/bot tags; `run.ts` ingest + orphans; `test_secret_rules.py` extra case; new `test/bot-loader-multi-account.test.ts`; `test/bot-loader.test.ts` updated so the old producer no longer writes UTC `EXPORTED_AT` + tree `MANIFEST.json`.

The loader matches the stated drop shape: per-bot `manifest.json` with size+sha256, no dated dirs, account/bot tags, skip bad size/sha per file, reject symlink/path-escape folders, ignore unlisted files, fail the bot on secrets. It is a different contract from fail-closed feeds (UTC stamp, sha-only entries, whole-feed skip).

## 2. Manifest validation

Adversarial cases: missing/wrong-typed `version`, empty/`>200` `bot_name`, missing `account`/`exported_at`, `files` as array, size as string/float, uppercase/short sha256 → whole bot skipped (`bad manifest`). Extra top-level keys and extra per-file keys are **accepted**. `bot_id` must equal the folder name; `bot_name` may differ (spaces allowed). Folder names outside `^[a-z0-9][a-z0-9_-]{0,63}$` (uppercase, space, `bot.a`, `..sneaky`) warn `bad folder name` and are not ingested.

## 3. Size, sha256, listed vs unlisted

Size mismatch skips that file (`size mismatch memory.md`) and still imports the rest. Sha mismatch same. Listed-but-missing is skipped with **`hash mismatch <rel>`** (not a distinct missing warning). Unlisted files are not ingested (`ignored unlisted N`). Official tests only cover same-length sha mismatch, not size-only.

## 4. Symlinks and path escape

File symlink, directory symlink, and export **root** symlink: not followed, folder/root skipped, canary bytes never appear. Manifest keys `../`, `/etc/passwd`, `C:\…`, backslashes, NUL, `skills//`, `skills/.` → `path escape` or `bad manifest`; **0 pages**.

## 5. TOCTOU / partial folder

After verify, swapping `memory.md` on disk does **not** change ingested bytes (in-memory buffer is used). Replacing `manifest.json` mid-run skips the bot (`manifest changed`). Swapping the whole folder for another drop with a different manifest does not mix pages. Missing `manifest.json` → `bad manifest`, nothing ingested. Recheck is **manifest bytes only**, not a second hash of each file; that is enough because each file is hashed from the buffer that is later written.

## 6. Idempotence and removals

Second run: `written=0` / `unchanged=5`, no extra `putPage`. File or bot removed the next night: summary matches `/orphan/i`; **pages stay on disk** and are not deleted or re-put. Designed behavior: report orphans, leave files, exclude from counts (`run.ts` `orphanLinesFor`).

## 7. Secret detection (content and names)

Rejected as claimed: OPENSSH private-key header, `password=…`, `.env` / `prod.env` names, `holdings.md`, `ada@example.com`, `555-010-0199`, `9 Example Road`, 16-digit card-shaped runs, `account` + 6+ digits.

**Slipped through detectors** (and, where noted, through the exporter):

- Email **body** without an address (`From:` / `Subject:` only) — **copied** as `notes/body.md` by `box-export.py`.
- Dotted / `+1` phones; `password:` (colon, not `=`); generic `api_key=`; `OPENAI_API_KEY=` without `sk-` shape; “ada at example dot com”; 5-digit “account”; 9-digit routing; SSN `123-45-6789`; “9 Example Place”; “holdings” in body; the word “token” in a sentence (intentional negative).
- Unlisted `.env` **rejects the whole bot**. Unlisted secret **content** in `extra.md` is ignored, not ingested.

## 8. `box-export.py`

Synthetic agent dir under `/tmp`: writes `_box-export/<bot>/{manifest.json,profile.json,memory.md,routines.md,skills/daily.md,notes/ok.md,notes/path.md,notes/body.md}`. Excludes holdings skill, `.env`, `id_rsa`, phone/email/street notes, attachments, `memory/log/token.md`. Manifest has `version`, `bot_name`, `bot_id`, `account`, NY `exported_at`, size+sha256; hashes matched. **No** `/home/…` or `/Users/…` in manifest or files. **Does** export an email-shaped note body. Default `--out` is not written into content.

## 9. ET vs #4 UTC

`isNewYorkExportTime` requires `YYYY-MM-DDTHH:MM:SS±HH:MM` whose offset **and** wall clock match `America/New_York`. Accepts winter `-05:00` and summer `-04:00`; rejects `Z`, naive, wrong offset, fractional seconds, `+00:00`. Spring-forward 02:30 rejected; fall-back 01:30 with either offset accepted. **No freshness/staleness**: `2099-…` and `1999-…` with a valid NY offset are accepted. Fail-closed #4 requires `…Z` (optional fraction) on `EXPORTED_AT` and skips the **whole** feed when older than `box_export_max_age_hours`.

## 10. Regression

Bot-loader + multi-account + fail-closed tests match the builder’s 45/0 (571). Full native `bun test` is red on **both** grok and HEAD with essentially the same fail set (managed-brain / embedding / graph-query / voyage, etc.). Those failures look environmental/pre-existing, not introduced by this PR. Typecheck OOM at 6GB is also on **both** bases; 12GB succeeds on both.

## 11. Mutations

| Mutation | Official 45 tests |
| --- | --- |
| Disable sha compare | 1 fail (sha mismatch test) |
| Disable size compare | **0 fail — finding** |
| Disable account match | 1 fail |
| Disable walkBot symlink | 1 fail |
| `sensitiveText` always false | 1 fail |
| Disable stamp-root overlap guard | 1 fail |
| Replace `run.ts` with grok | **10 fail / 1 pass**, not 1/10 |

## 12. Separation from #4 and `config.ts:405-408`

Keeping a second contract is reasonable: per-bot size+sha vs one signed tree, ET vs UTC, per-file skip vs whole-feed skip, different accounts. The **cost** is that `box-export.py` is no longer able to emit the fail-closed business tree; README says so, and #4 producer tests were rewritten. There is no remaining in-tree generator for `EXPORTED_AT` + `MANIFEST.json`.

Guard: trailing slash and an existing symlink from `_box-export-<account>` onto a fail-closed stamp **throw**. Identical resolved paths match even if missing (`pathsAreSame` compares `resolve` first). A **not-yet-created** export path with a **different** basename than `stamp_root` is not refused at config load; if it later becomes a **symlink**, `planExportRoots` still skips `root symlink`. A later **real directory copy** of a business tree would not match per-bot `manifest.json` and would skip as `bad manifest`. Linux case differences fail the `_box-export` / `_box-export-<account>` basename rule.

## 13. Privacy scan

Added diff: **0** emails, **0** `/home|/Users` paths, **0** IPv4, **0** `@handles`. One fake `BEGIN … PRIVATE KEY` sample in tests, composed / labeled as fake. Synthetic phone/email in tests are concatenated so they are not literal in the diff.

## Findings

1. **Medium** — `test/bot-loader-multi-account.test.ts` (no size-only case); `scripts/bot-loader/multi-account.ts:307-310`. Disabling the size check still yields **45/0**. Size is implemented but unpinned. Add a same-hash, different-size file test (or a size-only corrupt).

2. **Medium** — `scripts/bot-loader/export-deny.json` content list; `scripts/bot-loader/box-export.py` `copy_notes` (~251-270). Claim: never include **email bodies**. A `From:`/`Subject:` note with no `@` address was exported as `notes/body.md`. Detect message-header shapes or deny `notes` that look like mail, or drop the “email bodies” claim.

3. **Medium** — `scripts/bot-loader/box-export.py` (whole file) vs `scripts/bot-loader/fail-closed.ts:84-144`. The only in-tree producer for the #4 signed UTC tree was retargeted. Operators who still build business/hermes feeds with this script will emit a layout the fail-closed reader will skip. Split producers (`box-export.py` vs `box-export-feed.py`) or restore a `--fail-closed` mode.

4. **Low** — `scripts/bot-loader/multi-account.ts:137-168`. Extra JSON fields are ignored (schema is not strict). Reject unknown keys if the drop is supposed to be a closed manifest.

5. **Low** — `scripts/bot-loader/multi-account.ts:83-105` vs `fail-closed.ts:81-94`. Per-bot `exported_at` is not checked for age; a 1999 or 2099 NY stamp is valid. If nightly freshness matters, apply `box_export_max_age_hours` (or skip with a warning).

6. **Low** — `scripts/bot-loader/multi-account.ts:289-292`. Missing listed files log `hash mismatch`, which hides the real cause. Use `missing`.

7. **Low** — `docs/grok/bot-loader/config.example.json`. No `export_roots` example; only the multi-account doc shows it.

8. **Low (detector gaps, not all claimed)** — `secret-patterns.json` / `export-deny.json`. `password:`, dotted/`+1` phones, generic `api_key=`, SSN, “Place” addresses, holdings **in body** are not denied. Tighten only if those categories stay in the never-include list.

Builder note (not a product bug): “reverting `run.ts` fails 1/10” is false; it fails **10/11**.

## Could not check

- Docker/`bun run test:e2e` and `bun run ci:local`.
- Real share mounts or live account drops (synthetic `/tmp` only).
- Windows host path semantics (Windows-style keys were tested on Linux).
- `bun run test` (`scripts/run-unit-parallel.sh`); the requested command was native `bun test`.
- Whether a production business-feed job still invokes `box-export.py` outside this repo.

