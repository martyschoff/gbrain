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
_KEY_VALUE = re.compile(r"(?:api[_-]?key|access[_-]?token)\s*[=:]\s*(\S+)", re.IGNORECASE)


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
_CONTENT = _compile(_FILE["content"])


def secret_name(rel):
    base = rel.replace("\\", "/").split("/")[-1]
    return any(pattern.search(base) for pattern in _NAMES)


def secret_content(text):
    for pattern in _CONTENT:
        match = pattern.search(text)
        if not match:
            continue
        key = _KEY_VALUE.search(text[match.start():])
        if key and placeholder_secret(key.group(1)):
            continue
        return True
    return False
