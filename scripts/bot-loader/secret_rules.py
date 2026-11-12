#!/usr/bin/env python3
"""Secret skips loaded from secret-patterns.json (the same list as secrets.ts).

A match skips the whole file. Nothing from that file is copied into an export.
"""
from __future__ import annotations

import json
import os
import re

from export_deny import placeholder_secret

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "secret-patterns.json")


def _compile(rows):
    compiled = []
    for row in rows:
        flags = 0
        if "i" in row.get("flags", ""):
            flags |= re.IGNORECASE
        compiled.append(re.compile(row["source"], flags))
    return compiled


def load_patterns():
    with open(_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


_FILE = load_patterns()
_NAMES = _compile(_FILE["names"])
_PLAIN = [row for row in _FILE["content"] if not row.get("allow_placeholders")]
_KEYS = [row for row in _FILE["content"] if row.get("allow_placeholders")]
_CONTENT = _compile(_PLAIN)
_KEY_RES = []
for _row in _KEYS:
    _flags = re.IGNORECASE if "i" in _row.get("flags", "") else 0
    _KEY_RES.append(re.compile(_row["source"], _flags))


def secret_name(rel):
    base = rel.replace("\\", "/").split("/")[-1]
    return any(pattern.search(base) for pattern in _NAMES)


def _assignment_is_secret(text, pattern):
    for match in pattern.finditer(text):
        value = match.group(1)
        if value and not placeholder_secret(value):
            return True
    return False


def secret_content(text):
    if any(pattern.search(text) for pattern in _CONTENT):
        return True
    return any(_assignment_is_secret(text, pattern) for pattern in _KEY_RES)
