# Multi-account bot export

**Say to your agent:** *"Ingest the nightly bot drops from both account roots, tag each page with its account and bot, and skip any file whose manifest hash does not match."*

This is the drop the Grok Bot loader reads from `export_roots` in the local config. It is separate from the fail-closed business feed.

## Why this is not the business feed

The business drop added with the gbrain-feeds work is one signed tree, not a list of per-bot folders.

- The reader looks for a UTC `EXPORTED_AT` file and one `MANIFEST.json` at the stamp root (`scripts/bot-loader/fail-closed.ts:84`, `scripts/bot-loader/fail-closed.ts:124`).
- Each manifest entry is a sha256 string. There is no size (`scripts/bot-loader/fail-closed.ts:142-144`).
- A hash mismatch skips the whole feed (`scripts/bot-loader/fail-closed.ts:231-233`).
- A business group accepts only one fixed account tag, and its `box_export_dir` must be the same directory as `stamp_root` (`scripts/bot-loader/config.ts:196-197`, `scripts/bot-loader/config.ts:211-213`). That stamp cannot be the personal box-export directory (`scripts/bot-loader/config.ts:204-205`).
- The loader fixture for that feed is a directory whose basename is `_box-export`, with the manifest at the root of the tree (`test/bot-loader.test.ts:1242`). It is not `_box-export-<ACCOUNT-B>`, and it does not use a per-bot `manifest.json`, `memory.md`, `skills/`, or `routines.md`.

Account B's root is `<EXPORT-ROOT>/_box-export-<ACCOUNT-B>/`. Reusing the business stamp would point this loader at a different contract, so the two stay separate. An `export_roots` path that sits on a fail-closed stamp is refused (`scripts/bot-loader/config.ts:405-408`).

## Layout

There are no dated subfolders. Each bot folder is replaced wholesale every night. Bot folder names are lowercase and have no spaces (`^[a-z0-9][a-z0-9_-]{0,63}$`).

| Account | Root |
| --- | --- |
| `<ACCOUNT-A>` | `<EXPORT-ROOT>/_box-export/<BOT>/` |
| `<ACCOUNT-B>` | `<EXPORT-ROOT>/_box-export-<ACCOUNT-B>/<BOT>/` |

`<BOT>/<manifest.json>` fields:

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `bot_name` | Display name. It may contain spaces. It is not a path. |
| `bot_id` | Same string as the folder name. |
| `account` | The root's account tag. A mismatch skips the folder. |
| `exported_at` | Local export time in `America/New_York`, with a numeric offset such as `-05:00` or `-04:00`. |
| `files` | Every other file. Each value is `{ "size", "sha256" }`. `manifest.json` is not listed. |

Required files are `profile.json`, `memory.md` (each fact with its date), and `routines.md` (name, schedule, prompt). Optional files are `skills/<skill>.md` and `notes/<name>.md`, `notes/<name>.txt`, or `notes/<name>.json`. Skill and note names are lowercase and have no spaces.

Never include tokens, keys, passwords, `.env` files, holdings, account numbers, email bodies, street addresses, or phone numbers. The loader uses `scripts/bot-loader/secret-patterns.json` and `scripts/bot-loader/export-deny.json`. A match rejects that bot folder. A size or sha256 mismatch skips that file and logs the reason. A listed file that is not on disk logs `missing`. Unknown keys in `manifest.json` or in a file entry reject the folder. Unlisted files are not read. Symlinks are not followed; a symlink inside the bot folder rejects that folder. A path that leaves the bot folder rejects the folder. If `manifest.json` changes after the files are read, the folder is skipped. `exported_at` must fall inside `box_export_max_age_hours` of the run (default 36, in either direction). A stamp outside that window logs `stale` and imports nothing from that folder.

## Config

`export_roots` is a list. Each item has an account tag. Paths use the same `<share>` and `~` expansion as the rest of the loader config. This example is placeholders only:

```json
{
  "export_roots": [
    {
      "account": "account-a",
      "path": "<EXPORT-ROOT>/_box-export",
      "source": "account-a",
      "target_root": "<EXPORT-ROOT>/pages/account-a"
    },
    {
      "account": "account-b",
      "path": "<EXPORT-ROOT>/_box-export-account-b",
      "source": "account-b",
      "target_root": "<EXPORT-ROOT>/pages/account-b"
    }
  ]
}
```

The loader writes pages under `target_root/<account>/<BOT>/` and tags each page with `account`, `bot`, and `bot_name`. The same drop on a later night does not rewrite a page whose sha256 is already imported.

`scripts/bot-loader/box-export.py --account <ACCOUNT> --out <root>` writes this layout. `--out` is the account root (`_box-export` or `_box-export-<ACCOUNT>`), not a dated directory. `--fail-closed --source <SOURCE>` writes the other contract instead: a tree-level `EXPORTED_AT` and `MANIFEST.json` for a fail-closed feed. That flag is not the nightly drop.

## Drop instructions

Each night around 02:00 America/New_York, replace `<EXPORT-ROOT>/_box-export-<ACCOUNT-B>/<BOT>/` in full. Do not create a dated subfolder. `<BOT>` is lowercase and has no spaces. Write `manifest.json` (bot name, bot id, account `<ACCOUNT-B>`, the export time with an America/New_York offset, and the size and sha256 of every other file), `profile.json`, `memory.md` with each fact and its date, `skills/<skill>.md`, `routines.md` with each routine's name, schedule, and prompt, and an optional `notes/` folder. Do not include tokens, keys, passwords, `.env` files, holdings, account numbers, email bodies, street addresses, or phone numbers.
