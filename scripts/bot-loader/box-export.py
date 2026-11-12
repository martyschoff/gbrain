#!/usr/bin/env python3
"""Write a per-bot nightly drop. Does not modify sources.

--out is the account root (<EXPORT-ROOT>/_box-export or
<EXPORT-ROOT>/_box-export-<ACCOUNT>). Each bot folder is replaced wholesale.
There is no dated subfolder and no tree-level MANIFEST.json.

Each bot folder contains manifest.json, profile.json, memory.md, routines.md,
optional skills/<skill>.md, and optional notes/. manifest.json records the bot
name, bot id, account, an America/New_York export time, and the size and sha256
of every other file.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_deny import denied_content, denied_name
from secret_rules import secret_content, secret_name

DEFAULT_OUT = os.path.expanduser("~/.gbrain/box-export")
BOT_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
SKILL_FILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}\.md$")
NOTE_FILE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}\.(?:md|txt|json)$")
DATE_STEM = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATE_LINE = re.compile(r"^(\d{4}-\d{2}-\d{2})\b")


def ny_stamp():
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo("America/New_York"))
    except Exception as error:
        raise SystemExit("config: America/New_York timezone data is missing") from error
    offset = now.strftime("%z")
    if len(offset) != 5:
        raise SystemExit("config: America/New_York offset is unavailable")
    return now.strftime("%Y-%m-%dT%H:%M:%S") + offset[:3] + ":" + offset[3:]


def load_bots(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    bots = data.get("bots")
    if not isinstance(bots, dict) or not bots:
        raise SystemExit("config: bots must be an object of name to directory")
    mapping = {}
    for name, directory in bots.items():
        if not isinstance(name, str) or not isinstance(directory, str) or not BOT_SLUG.match(name) or not directory:
            raise SystemExit("config: each bot maps a lowercase name with no spaces to a directory")
        mapping[name] = os.path.expanduser(directory)
    return mapping


def confined(root, rel):
    """Regular file under root, or None. Symlinks and paths that escape are ignored."""
    if rel.startswith("/") or "\\" in rel:
        return None
    parts = rel.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    current = os.path.abspath(root)
    root_abs = current
    for part in parts:
        current = os.path.join(current, part)
        if os.path.islink(current):
            return None
    try:
        if os.path.commonpath([root_abs, current]) != root_abs:
            return None
    except ValueError:
        return None
    if not os.path.isfile(current):
        return None
    return current


def sensitive_name(rel):
    return secret_name(rel) or denied_name(rel)


def sensitive_text(text):
    return secret_content(text) or denied_content(text)


def read_copy(path, secrets):
    """Return bytes to copy, or None when the file must be left out."""
    try:
        with open(path, "rb") as handle:
            payload = handle.read()
    except OSError:
        secrets[0] += 1
        return None
    if b"\x00" in payload:
        secrets[0] += 1
        return None
    try:
        text = payload.decode("utf-8")
    except UnicodeError:
        secrets[0] += 1
        return None
    if sensitive_text(text):
        secrets[0] += 1
        return None
    return payload


def count_sensitive_names(root, secrets):
    if not os.path.isdir(root) or os.path.islink(root):
        return
    stack = [root]
    while stack:
        directory = stack.pop()
        if os.path.islink(directory):
            continue
        try:
            names = os.listdir(directory)
        except OSError:
            continue
        for name in names:
            path = os.path.join(directory, name)
            if sensitive_name(name):
                secrets[0] += 1
                continue
            if os.path.islink(path):
                continue
            if os.path.isdir(path):
                stack.append(path)


def fact_date(name, text):
    stem = name[:-3] if name.endswith(".md") else name
    if DATE_STEM.match(stem):
        return stem
    first = text.strip().splitlines()[0] if text.strip() else ""
    match = DATE_LINE.match(first.strip())
    if match:
        return match.group(1)
    return "undated"


def compile_memory(root, secrets):
    direct = confined(root, "memory.md")
    if direct is not None:
        copied = read_copy(direct, secrets)
        if copied is not None:
            return copied
    sections = []
    profile = confined(root, "memory/profile.md")
    if profile is not None:
        copied = read_copy(profile, secrets)
        if copied is not None:
            text = copied.decode("utf-8").strip()
            sections.append("## %s\n\n%s\n" % (fact_date("profile.md", text), text))
    log_dir = os.path.join(root, "memory", "log")
    if os.path.isdir(log_dir) and not os.path.islink(log_dir):
        try:
            names = sorted(os.listdir(log_dir))
        except OSError:
            names = []
        for name in names:
            if not name.endswith(".md") or sensitive_name(name):
                continue
            path = confined(root, "memory/log/" + name)
            if path is None:
                continue
            copied = read_copy(path, secrets)
            if copied is None:
                continue
            text = copied.decode("utf-8").strip()
            sections.append("## %s\n\n%s\n" % (fact_date(name, text), text))
    if not sections:
        body = "# Memory\n\n_No facts were exported._\n"
    else:
        body = "# Memory\n\n" + "\n".join(sections)
    if sensitive_text(body):
        secrets[0] += 1
        return b"# Memory\n\n_No facts were exported._\n"
    return body.encode("utf-8")


def compile_routines(root, secrets):
    direct = confined(root, "routines.md")
    if direct is not None:
        copied = read_copy(direct, secrets)
        if copied is not None:
            return copied
    raw_path = confined(root, "routines.json")
    items = []
    if raw_path is not None:
        copied = read_copy(raw_path, secrets)
        if copied is not None:
            try:
                parsed = json.loads(copied.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError):
                parsed = None
            if isinstance(parsed, list):
                items = parsed
    lines = ["# Routines", ""]
    kept = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        schedule = item.get("schedule")
        prompt = item.get("prompt")
        if not all(isinstance(value, str) and value.strip() for value in (name, schedule, prompt)):
            continue
        block = name + "\n" + schedule + "\n" + prompt
        if sensitive_text(block) or sensitive_name(name):
            secrets[0] += 1
            continue
        lines.extend(["## " + name.strip(), "", "- schedule: " + schedule.strip(), "- prompt: " + prompt.strip(), ""])
        kept += 1
    if kept == 0:
        lines.append("_No routines were exported._")
        lines.append("")
    return ("\n".join(lines)).encode("utf-8")


def copy_skills(root, secrets):
    found = {}
    directory = os.path.join(root, "skills")
    if not os.path.isdir(directory) or os.path.islink(directory):
        return found
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return found
    for name in names:
        if not SKILL_FILE.match(name) or sensitive_name(name):
            continue
        path = confined(root, "skills/" + name)
        if path is None:
            continue
        copied = read_copy(path, secrets)
        if copied is None:
            continue
        found["skills/" + name] = copied
    return found


def copy_notes(root, secrets):
    found = {}
    directory = os.path.join(root, "notes")
    if not os.path.isdir(directory) or os.path.islink(directory):
        return found
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return found
    for name in names:
        if not NOTE_FILE.match(name) or sensitive_name(name):
            continue
        path = confined(root, "notes/" + name)
        if path is None:
            continue
        copied = read_copy(path, secrets)
        if copied is None:
            continue
        found["notes/" + name] = copied
    return found


def bot_display_name(profile, bot_id, secrets):
    try:
        parsed = json.loads(profile.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        return bot_id
    if not isinstance(parsed, dict):
        return bot_id
    name = parsed.get("name")
    if not isinstance(name, str) or not name.strip():
        return bot_id
    if sensitive_text(name) or any(char in name for char in "\r\n"):
        secrets[0] += 1
        return bot_id
    return name.strip()


def build_bot(bot_id, root, account, stamp):
    secrets = [0]
    if os.path.islink(root) or not os.path.isdir(root):
        return None, secrets[0], True
    count_sensitive_names(root, secrets)
    profile_path = confined(root, "profile.json")
    if profile_path is None:
        profile = ('{"id":"%s","name":"%s"}\n' % (bot_id, bot_id)).encode("utf-8")
    else:
        copied = read_copy(profile_path, secrets)
        if copied is None:
            profile = ('{"id":"%s","name":"%s"}\n' % (bot_id, bot_id)).encode("utf-8")
        else:
            profile = copied
    files = {
        "profile.json": profile,
        "memory.md": compile_memory(root, secrets),
        "routines.md": compile_routines(root, secrets),
    }
    files.update(copy_skills(root, secrets))
    files.update(copy_notes(root, secrets))
    listed = {}
    for rel in sorted(files):
        payload = files[rel]
        listed[rel] = {"size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    manifest = {
        "version": 1,
        "bot_name": bot_display_name(profile, bot_id, secrets),
        "bot_id": bot_id,
        "account": account,
        "exported_at": stamp,
        "files": listed,
    }
    files["manifest.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    return files, secrets[0], False


def export_tree(bots, out_dir, dry_run, account):
    stamp = ny_stamp()
    built = []
    for name in bots:
        files, secrets, missing = build_bot(name, bots[name], account, stamp)
        content_count = 0 if files is None else len(files) - (1 if "manifest.json" in files else 0)
        built.append((name, files, content_count, secrets, missing))
    if dry_run:
        for name, _files, copied, secrets, missing in built:
            missing_note = " missing=1" if missing else ""
            sys.stdout.write("dry-run bot %s files=%s secrets_skipped=%s%s\n" % (name, copied, secrets, missing_note))
        return 0
    parent = os.path.dirname(os.path.abspath(out_dir)) or "."
    os.makedirs(parent, exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".box-export.", dir=parent)
    try:
        for name, files, _copied, _secrets, missing in built:
            if missing or files is None:
                continue
            for rel, payload in files.items():
                dest = os.path.join(staging, name, *rel.split("/"))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as handle:
                    handle.write(payload)
        backup = out_dir + ".bak"
        if os.path.isdir(backup):
            shutil.rmtree(backup)
        if os.path.isdir(out_dir):
            os.rename(out_dir, backup)
        os.rename(staging, out_dir)
        staging = None
        if os.path.isdir(backup):
            shutil.rmtree(backup)
    finally:
        if staging and os.path.isdir(staging):
            shutil.rmtree(staging)
    for name, _files, copied, secrets, missing in built:
        missing_note = " missing=1" if missing else ""
        sys.stdout.write("bot %s files=%s secrets_skipped=%s%s\n" % (name, copied, secrets, missing_note))
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description="Write per-bot export folders. Does not modify sources.")
    parser.add_argument("config", help="JSON file mapping bot name to an agent-data directory")
    parser.add_argument("--out", default=DEFAULT_OUT, help="account root to replace (default: %s)" % DEFAULT_OUT)
    parser.add_argument("--dry-run", action="store_true", help="print counts only; write nothing")
    parser.add_argument("--account", help="account tag written into each manifest.json")
    args = parser.parse_args(argv)
    if args.account is None or args.account.strip() == "" or not BOT_SLUG.match(args.account.strip()):
        raise SystemExit("config: --account must be a lowercase slug with no spaces")
    bots = load_bots(args.config)
    return export_tree(bots, os.path.expanduser(args.out), args.dry_run, args.account.strip())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
