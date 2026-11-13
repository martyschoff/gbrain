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


def _line_at(text, index, lexeme=""):
    if lexeme.startswith("\r\n"):
        index += 2
    elif lexeme.startswith("\n"):
        index += 1
    return text.count("\n", 0, index) + 1


def secret_name_rule(rel):
    """First filename rule label, or None. Never the matched text."""
    base = rel.replace("\\", "/").split("/")[-1]
    for index, pattern in enumerate(_NAMES):
        if pattern.search(base):
            return "secrets.names[%d]" % index
    return None


def secret_name(rel):
    return secret_name_rule(rel) is not None


def _assignment_match(text, pattern):
    for match in pattern.finditer(text):
        value = match.group(1)
        if value and not placeholder_secret(value):
            return match
    return None


def secret_content_match(text):
    """First content rule, with a 1-based line. Placeholder keys use secrets.key_assignment."""
    plain_at = 0
    for index, row in enumerate(_FILE["content"]):
        if row.get("allow_placeholders"):
            continue
        match = _CONTENT[plain_at].search(text)
        plain_at += 1
        if match:
            return {
                "rule": "secrets.content[%d]" % index,
                "line": _line_at(text, match.start(), match.group(0)),
                "index": match.start(),
                "length": len(match.group(0)),
            }
    for pattern in _KEY_RES:
        match = _assignment_match(text, pattern)
        if match:
            lexeme = match.group(0)
            start = match.start() + (1 if lexeme.startswith("\n") else 0)
            return {
                "rule": "secrets.key_assignment",
                "line": _line_at(text, start),
                "index": start,
                "length": len(lexeme) - (start - match.start()),
            }
    return None


def secret_content_rule(text):
    hit = secret_content_match(text)
    return None if hit is None else hit["rule"]


def secret_content(text):
    return secret_content_rule(text) is not None
