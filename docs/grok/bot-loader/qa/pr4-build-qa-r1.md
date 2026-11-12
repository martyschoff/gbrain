# gbrain PR #4 (gbrain-feeds) build QA r1 (CloudQA)

- PR: https://github.com/martyschoff/gbrain/pull/4
- Branch: feature/gbrain-feeds into grok (base 505530f), head 43fa5c848c26ceff0a1ed8a5452b11150b6e8772
- Spec: gbrain-feeds design v7 (534 lines, sha256 426f2098...cf01), Martin-approved with Q1-Q6 defaults; provided to the reviewer only, not in this repo.
- Reviewer: Cursor cloud agent bc-3d2cb082, model grok-4.6, effort medium (read-only)
- Note: reviewer is the same model family as the builder (grok-4.7); Claude cloud launches need credits.
- Ran: bun test test/bot-loader.test.ts, test_secret_rules.py, typecheck script, overlay of base sources with new tests, scratch scenario and mutation checks.
- Note (not a finding): the typecheck script at its 6144 MB heap ran out of memory on the review VM; the same tsc at 12288 MB exited 0. Worth confirming on the build host.

---

Verdict: FAIL

HEAD `43fa5c848c26ceff0a1ed8a5452b11150b6e8772`. Merge-base with `505530f` is `505530f65ad75ee3e85a3a72b83ea45bd6488e58`. Spec file: 534 lines, sha256 `426f209879c2b9a05b4c1cf423f9ee1ce5cdb6dd4f2b1f26c5fb26a7933acf01` (match). PR #4 body was readable via `gh`; builder choices below are taken from that body plus the code.

Diff vs `505530f`: 8 files, all bot-loader (`docs/grok/bot-loader/README.md`, `scripts/bot-loader/{box-export.py,config.ts,fail-closed.ts,run.ts,scan.ts,summary.ts}`, `test/bot-loader.test.ts`). No master/hermes-only `src/` paths. No plist change. No business launchd.

### What ran

| Command | Claim | Actual |
|---|---|---|
| `bun test test/bot-loader.test.ts` | 31 pass / 0 fail (441 expects) | **31 pass / 0 fail / 441 expects** |
| `python3 scripts/bot-loader/test_secret_rules.py` | 2 OK | **2 tests, OK** |
| `bun run typecheck` (`node --max-old-space-size=6144 … tsc --noEmit`) | exit 0 | **SIGABRT OOM** after ~161s (heap ~6040 MB). Same `tsc` with **12288 MB: exit 0** |
| Overlay: restore `505530f` sources, keep HEAD tests | 25 pass / 6 fail | **25 pass / 6 fail / 339 expects** |
| Full `bun test` | — | not run |

Scratch under `/tmp` (HEAD sources): content-secret `.md` → `empty after allowlist`; mixed secret+`.md` → `denied path in manifest`; hermes stale + business fresh → business still writes. Mutation: swap `'feed stale'` → 30/1 (string test fails). Premature `mkdir`+sentinel in `checkFailClosed` → **31/0 (tests still pass)**. Fail-closed skip `break`s the group loop → 28/3 (F3/isolation tests fail).

### C1–C11 / C5b

Assembly is always `SKIP ${group.source}: ${token}` at `scripts/bot-loader/run.ts:145` (C10 also `run.ts:280`). Tokens vs spec §4.3 are character-identical where they fire. `secret-bearing` is in source but not reachable (N1).

| Check | Location | Token | §4.3 match |
|---|---|---|---|
| C10 empty bots | `run.ts:280`, `fail-closed.ts:217` | `SKIP <source>: no bots named` | exact |
| C9 partial | `fail-closed.ts:45-48,64,71,220-221` (before C1 stamp) | `SKIP <source>: partial copy` | exact string; **order** is before C1 (builder: basename `_box-export.in` / `.bak`). Matches §7 Step 2, not table order |
| C1 dir | `fail-closed.ts:63-78,221` | `SKIP <source>: input missing` | exact |
| C1 stamp | `fail-closed.ts:54-56,81-94,223` | `SKIP hermes: feed stale` / `SKIP business: box-export stale` | exact |
| C2 unsigned | `fail-closed.ts:121-157,225,237-239` | `SKIP <source>: unsigned` | exact (also used for count/`exported_at` accounting) |
| C3 hash | `fail-closed.ts:229-236` | `SKIP <source>: hash mismatch` | exact |
| C4 oversized | `fail-closed.ts:240-242` | `SKIP <source>: oversized` | exact |
| C7 finance | `fail-closed.ts:244-250` | `SKIP <source>: finance-data` | exact; **order** after C4, before C5 (builder: so `positions.csv` is not C5). Matches §7 Step 4, not table order |
| C5 empty allowlist | `fail-closed.ts:260` | `SKIP <source>: empty after allowlist` | exact |
| C5b denied path | `fail-closed.ts:261` | `SKIP <source>: denied path in manifest` | exact |
| C6 secret | `fail-closed.ts:262-264` | `SKIP <source>: secret-bearing` | string present; **never produced** (N1) |
| C8 wrong source | `fail-closed.ts:265` | `SKIP <source>: wrong source` | exact |
| C11 route | `fail-closed.ts:184-201,269-285` | `SKIP <source>: route` | exact; uses `routeRejected`, not `assertDestination` (needed for the symlink G3 case) |
| C11 ensure | `run.ts:288-291` | `SKIP <source>: source not created` | exact |
| WARN personal stamp | `run.ts:46-54` + `summary.ts:32` | `WARN box-export stale` | exact |

No extra SKIP strings. First write under a group destination is `writeAtomic` in `commitPlanned` (`run.ts:331`) after `checkFailClosed` returns ok and after optional `ensureSource`. `checkFailClosed` itself has no `writeAtomic`/`mkdirSync`. Whole-run lock (`host.ts`) and final summary/state writes are after the group loop (summary) or pre-existing (lock), not under the group `target_root`. Personal `mkdirSync` remains only on the non-fail-closed branch (`run.ts:157`).

### Builder choices vs Q1–Q6 / v7

Documented in PR #4 and consistent with defaults: sources `business` / `hermes`; accounts `businessgrok` / `hermes`; empty `bots` → `no bots named`, no `ensureSource`; no agent-relay / notices; no business launchd; `--account`+`--source` together for MANIFEST; Hermes allowlist default `.md`/`.txt`; C9 early and C7-before-C5 as above. **Not OK:** folding secrets into C5/C5b so C6 cannot fire (PR text even says this).

`personalgrok` warn-and-continue: old tests still pass on HEAD; overlay old sources keep those 25 green. `config.ts`/`run.ts` personal branch is the old path behind `failClosed === false`. `scanTree` unchanged. `box-export.py` with no flags still EXPORTED_AT-only (allowlist reused; `.png` / `secret.env` not copied; MANIFEST lists copied files only).

### §7 fixtures

Present: example config load; stamp_root/account throws; Hermes stamp = personal box throw; business `box_export_dir` mismatch; omitted inputs throw; empty bots load; C1 missing vs stale; unsigned; hash; `_box-export.in` → partial copy; route + zero hermes pages; Holdings / `positions.csv` → finance-data; body “portfolio” imported; G1 both directions; F3 ensure skip + hermes runs; personal secret omit; C5b mixed png+md; extras ignored; C5 only-denied; verify.sh with business SKIP. **Missing:** dedicated **business** 37h → `SKIP business: box-export stale`; C6 `secret-bearing`; G3 `writeAtomic` spy (inferred via `existsSync` / puts only).

### Nn

### N1 - Medium - C6 `secret-bearing` is dead; secrets are reported as C5/C5b

`scripts/bot-loader/fail-closed.ts:255-264` (`classifyScannedFile` at `scan.ts:51-64`). Spec §4.1 C6 / §4.3: remaining files matching `secret_name` / `secret_content` → `SKIP <source>: secret-bearing`. C5b is extension/path refuse. Implementation counts `secret` like a deny, so a lone secret `.md` is `empty after allowlist` and a secret plus a clean `.md` is `denied path in manifest`. Scratch on HEAD confirmed both. Whole-group skip still happens (no leak), but the required token never appears. Risk §6.5 (whole-feed secret skip vs personal per-file omit) is therefore mislabeled. **Fix:** allowlist/path denials only for C5/C5b; run C6 on files that remain; add a fixture that expects `SKIP hermes: secret-bearing` and zero writes.

### N2 - Low - C1 stamp rejects parseable UTC with fractional seconds

`fail-closed.ts:9,81-89`. Spec §4.1 C1: fail when the first line is not parseable UTC. `2026-11-12T11:00:00.000Z` parses as UTC; this regex returns `feed stale` / `box-export stale` (confirmed). §5 says ISO-8601-Z; box-export writes seconds-only, but a Hermes stamp with millis would SKIP. **Fix:** parse with `Date.parse` (or allow optional `.sss`), keep the age check.

### N3 - Low - §7 Step 2 business stale fixture missing

Only Hermes 37h is tested (`test/bot-loader.test.ts:1057-1063`). `staleToken` (`fail-closed.ts:54-56`) would emit `box-export stale` for `business`, but nothing asserts `SKIP business: box-export stale`. A swapped ternary would still pass CI. **Fix:** add the business 37h stamp case from Step 2.

### N4 - Low - G3 / “no write before checks” is not actually spied

§7 Step 3 / §4 G3: zero hermes `writeAtomic` calls (spy). Tests only check destination page paths and `put` spies (`test/bot-loader.test.ts:1165-1172` and similar). Mutating `checkFailClosed` to `mkdirSync(targetRoot)` and write a sentinel still **31 pass / 0 fail**. Page-path writes are covered; other destination writes are not. **Fix:** spy `writeAtomic` (and mkdir under `target_root`) and assert zero calls on SKIP.

Privacy (added lines): no IPs, emails, UUIDs, or home-dir usernames. Folder names `personalgrok` / `businessgrok` under a temp share: **acceptable** (spec names businessgrok; personalgrok is the existing drop layout). Fixture `sk-abcdefghijklmnopqrstuvwxyz`: **acceptable** — alphabet after `sk-`, reused from the pre-existing personal secret test, matches the shared `\bsk-[A-Za-z0-9]{16,}` pattern, obviously fake, unlikely to be treated as a live key. No long spec prose copied; README lists the required SKIP tokens.

Could not check: full unit suite (`bun test` / `run-unit-parallel.sh`); typecheck at the claimed 6144 MB heap (OOM here; 12288 MB succeeded); live Mac launchd, SMB ACLs (Q6), Windows copy, or a real Hermes exporter; `writeAtomic` under a real `gbrain` `ensureSource` (tests use a spy).
