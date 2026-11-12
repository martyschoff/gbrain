#!/usr/bin/env python3
"""Extra drop denials shared with scripts/bot-loader/export-deny.json.

Name and content checks for holdings, account numbers, and contact data.
secret_rules.py remains the token and key list.
"""
from __future__ import annotations

import json
import os
import re

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "export-deny.json")


def _compile(rows):
    compiled = []
    for row in rows:
        flags = 0
        if "i" in row.get("flags", ""):
            flags |= re.IGNORECASE
        compiled.append(re.compile(row["source"], flags))
    return compiled


def load_denies():
    with open(_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


_FILE = load_denies()
_NAMES = _compile(_FILE["names"])
_CONTENT = _compile(_FILE["content"])
_MAIL_HEADERS = _FILE.get("mail_headers") or []
_MAIL_MIN = int(_FILE.get("mail_min_headers") or 2)
_MAIL_SCAN = int(_FILE.get("mail_scan_lines") or 20)
_MAIL_LINE = None
if _MAIL_HEADERS:
    _MAIL_LINE = re.compile(
        r"^(?:" + "|".join(re.escape(name) for name in _MAIL_HEADERS) + r"):[ \t]+\S",
        re.IGNORECASE,
    )


def denied_name(rel):
    base = rel.replace("\\", "/").split("/")[-1]
    return any(pattern.search(base) for pattern in _NAMES)


def looks_like_mail(text):
    """Several RFC 822 header lines near the top, with or without an address."""
    if _MAIL_LINE is None:
        return False
    count = 0
    for line in text.splitlines()[:_MAIL_SCAN]:
        if _MAIL_LINE.match(line):
            count += 1
    return count >= _MAIL_MIN


def denied_content(text):
    if looks_like_mail(text):
        return True
    return any(pattern.search(text) for pattern in _CONTENT)
