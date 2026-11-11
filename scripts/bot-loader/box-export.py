#!/usr/bin/env python3
"""Copy allowlisted agent text into a fresh output tree.

The only required argument is a config file mapping bot name to an agent-data
directory. --out defaults to ~/.gbrain/box-export. Sources are never modified.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone

DEFAULT_OUT = os.path.expanduser("~/.gbrain/box-export")

SECRET_NAME = re.compile(
    r"(?:^|/)(?:\.env(?:\.|$)|auth\.json$|id_rsa|[^/]*token[^/]*|[^/]*secret[^/]*|[^/]*credential[^/]*|[^/]*\.pem$|[^/]*\.key$)",
    re.IGNORECASE,
)
SECRET_CONTENT = [
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"\bsk-[A-Za-z0-9]{16,}"),
    re.compile(r"\bghp_[A-Za-z0-9]{16,}"),
    re.compile(r"\bxox[a-z]-[A-Za-z0-9-]{10,}", re.IGNORECASE),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b[Bb]earer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}"),
]


def secret_name(rel):
    return SECRET_NAME.search(rel.replace("\\", "/")) is not None


def secret_content(text):
    return any(pattern.search(text) for pattern in SECRET_CONTENT)


def allowlisted(root):
    """Relative posix paths this helper is allowed to read."""
    found = []
    exact = ["profile.json", "memory/profile.md"]
    for rel in exact:
        path = os.path.join(root, *rel.split("/"))
        if os.path.isfile(path) and not os.path.islink(path):
            found.append(rel)
    for folder, suffix in (("memory/log", ".md"), ("attachments", ".md"), ("attachments", ".txt")):
        directory = os.path.join(root, *folder.split("/"))
        if not os.path.isdir(directory) or os.path.islink(directory):
            continue
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            if not name.endswith(suffix):
                continue
            path = os.path.join(directory, name)
            if os.path.isfile(path) and not os.path.islink(path):
                found.append(folder + "/" + name)
    return found


def load_bots(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    bots = data.get("bots")
    if not isinstance(bots, dict) or not bots:
        raise SystemExit("config: bots must be an object of name to directory")
    mapping = {}
    for name, directory in bots.items():
        if not isinstance(name, str) or not isinstance(directory, str) or not name or not directory:
            raise SystemExit("config: each bot maps a name to a directory")
        mapping[name] = os.path.expanduser(directory)
    return mapping


def export_tree(bots, out_dir, dry_run):
    counts = {}
    files = []
    missing = []
    for name in bots:
        copied = 0
        secrets = 0
        root = bots[name]
        if not os.path.isdir(root):
            counts[name] = (0, 0)
            missing.append(name)
            continue
        for rel in allowlisted(root):
            if secret_name(rel):
                secrets += 1
                continue
            source = os.path.join(root, *rel.split("/"))
            try:
                with open(source, "r", encoding="utf-8") as handle:
                    text = handle.read()
            except (OSError, UnicodeError):
                secrets += 1
                continue
            if secret_content(text):
                secrets += 1
                continue
            files.append((name, rel, text))
            copied += 1
        counts[name] = (copied, secrets)
    if dry_run:
        for name, (copied, secrets) in counts.items():
            missing_note = " missing=1" if name in missing else ""
            sys.stdout.write("dry-run bot %s files=%s secrets_skipped=%s%s\n" % (name, copied, secrets, missing_note))
        return 0
    parent = os.path.dirname(os.path.abspath(out_dir)) or "."
    os.makedirs(parent, exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".box-export.", dir=parent)
    try:
        for name, rel, text in files:
            dest = os.path.join(staging, name, *rel.split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as handle:
                handle.write(text)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        lines = [stamp]
        for name, (copied, _secrets) in counts.items():
            lines.append("%s %s" % (name, copied))
        with open(os.path.join(staging, "EXPORTED_AT"), "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
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
    for name, (copied, secrets) in counts.items():
        sys.stdout.write("bot %s files=%s secrets_skipped=%s\n" % (name, copied, secrets))
    return 0


def main(argv):
    parser = argparse.ArgumentParser(description="Copy allowlisted bot text. Does not modify sources.")
    parser.add_argument("config", help="JSON file mapping bot name to an agent-data directory")
    parser.add_argument("--out", default=DEFAULT_OUT, help="output directory (default: %s)" % DEFAULT_OUT)
    parser.add_argument("--dry-run", action="store_true", help="print counts only; write nothing")
    args = parser.parse_args(argv)
    bots = load_bots(args.config)
    return export_tree(bots, os.path.expanduser(args.out), args.dry_run)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
