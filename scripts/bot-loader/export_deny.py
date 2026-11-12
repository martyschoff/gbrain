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
_MAIL_MIN = int(_FILE.get("mail_min_headers") or 2)
_MAIL_SCAN = int(_FILE.get("mail_scan_lines") or 20)


def _header_line(names):
    if not names:
        return None
    return re.compile(
        r"^(?:" + "|".join(re.escape(name) for name in names) + r"):[ \t]+\S",
        re.IGNORECASE,
    )


_ADDRESS_LINE = _header_line(_FILE.get("mail_address_headers") or [])
_OTHER_LINE = _header_line(_FILE.get("mail_other_headers") or [])


def _without_front_matter(text):
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            return "\n".join(lines[index + 1 :])
    return text


def denied_name(rel):
    base = rel.replace("\\", "/").split("/")[-1]
    return any(pattern.search(base) for pattern in _NAMES)


def looks_like_mail(text):
    """An address header plus another mail header, after a leading YAML block."""
    if _ADDRESS_LINE is None:
        return False
    address = 0
    other = 0
    for line in _without_front_matter(text).splitlines()[:_MAIL_SCAN]:
        if _ADDRESS_LINE.match(line):
            address += 1
        elif _OTHER_LINE is not None and _OTHER_LINE.match(line):
            other += 1
    return address >= 1 and address + other >= _MAIL_MIN


def denied_content(text):
    if looks_like_mail(text):
        return True
    return any(pattern.search(text) for pattern in _CONTENT)
