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
        if "m" in row.get("flags", ""):
            flags |= re.MULTILINE
        compiled.append(re.compile(row["source"], flags))
    return compiled


def load_denies():
    with open(_PATH, "r", encoding="utf-8") as handle:
        return json.load(handle)


_FILE = load_denies()
_NAMES = _compile(_FILE["names"])
_CONTENT = _compile(_FILE["content"])
_KEY = _FILE.get("key_assignment") or {}
_KEY_RE = None
if _KEY.get("source"):
    _key_flags = re.IGNORECASE if "i" in _KEY.get("flags", "") else 0
    _KEY_RE = re.compile(_KEY["source"], _key_flags)
_KEY_MIN = int(_KEY.get("min_length") or 8)
_MAIL_HEADERS = _FILE.get("mail_headers") or []
_ADDRESS_HEADERS = {name.lower() for name in (_FILE.get("mail_address_headers") or [])}
_STRONG_HEADERS = {name.lower() for name in (_FILE.get("mail_strong_headers") or [])}
_BLOCK_HEADERS = _FILE.get("mail_block_headers") or []
_MAIL_MIN = int(_FILE.get("mail_min_headers") or 2)
_BLOCK_MIN = int(_FILE.get("mail_block_min") or 3)
_MAIL_SCAN = int(_FILE.get("mail_scan_lines") or 20)
_MAIL_MARKERS = _compile(_FILE.get("mail_markers") or [])
_MAIL_LINE = None
_ADDRESS_VALUE = re.compile(r"<[^\s<>]*@[^\s<>]*>|[^\s<>@]+@[^\s<>@]+")
_BLOCK_LINE = None
_STRONG_LINE = None
if _MAIL_HEADERS:
    _MAIL_LINE = re.compile(
        r"^(" + "|".join(re.escape(name) for name in _MAIL_HEADERS) + r"):[ \t]+(\S.*)$",
        re.IGNORECASE,
    )
if _BLOCK_HEADERS:
    _BLOCK_LINE = re.compile(
        r"^[ \t]*(?:>[ \t]*)?(?:" + "|".join(re.escape(name) for name in _BLOCK_HEADERS) + r"):[ \t]+\S",
        re.IGNORECASE,
    )
if _STRONG_HEADERS:
    _STRONG_LINE = re.compile(
        r"^(?:" + "|".join(re.escape(name) for name in _STRONG_HEADERS) + r"):[ \t]+\S",
        re.IGNORECASE,
    )


def _unquote(value):
    bare = value.strip()
    if len(bare) >= 2 and bare[0] == bare[-1] and bare[0] in "\"'":
        return bare[1:-1]
    return bare


def placeholder_secret(value):
    """ALL_CAPS words, angle placeholders, and handbook tokens are not keys."""
    bare = _unquote(value)
    if bare.startswith("<") and bare.endswith(">") and len(bare) >= 2:
        return True
    if re.fullmatch(r"x{3,}", bare, re.IGNORECASE):
        return True
    if re.match(r"(?i)^(?:SEE_|EXAMPLE|YOUR_)", bare):
        return True
    if re.fullmatch(r"[A-Z][A-Z0-9_]{7,}", bare):
        return True
    return False


def _denied_key(text):
    if _KEY_RE is None:
        return False
    for match in _KEY_RE.finditer(text):
        bare = _unquote(match.group(1))
        if len(bare) >= _KEY_MIN and not placeholder_secret(bare):
            return True
    return False


def denied_name(rel):
    base = rel.replace("\\", "/").split("/")[-1]
    return any(pattern.search(base) for pattern in _NAMES)


def _mail_lines(text):
    """Drop a leading closed front-matter block.

    The block counts only when line 1 is ``---`` and a later line closes it.
    An unclosed ``---`` is ordinary text. Message-ID and Received stay visible
    inside that closed block.
    """
    lines = text.splitlines()
    close = -1
    if lines and lines[0].strip() == "---":
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                close = index
                break
    visible = []
    for index, line in enumerate(lines):
        if len(visible) >= _MAIL_SCAN:
            break
        inside = close > 0 and 0 < index < close
        if inside and not (_STRONG_LINE is not None and _STRONG_LINE.match(line)):
            continue
        if close > 0 and index in (0, close):
            continue
        visible.append(line)
    return visible


def _header_candidate(line):
    return re.sub(r"^(?:>\s*)+", "", line.strip())


def _contiguous_header_block(lines):
    """A run of header lines anywhere in the window, not only at line 1."""
    if _BLOCK_LINE is None:
        return False
    run = 0
    for line in lines:
        candidate = _header_candidate(line)
        if _BLOCK_LINE.match(candidate):
            run += 1
            if run >= _BLOCK_MIN:
                return True
            continue
        run = 0
    return False


def looks_like_mail(text):
    """Address, Message-ID/Received, three header lines anywhere, or a forward marker.

    Only a leading closed YAML block is ignored.
    """
    if _MAIL_LINE is None:
        return False
    lines = _mail_lines(text)
    if any(pattern.search(line) for line in lines for pattern in _MAIL_MARKERS):
        return True
    if _contiguous_header_block(lines):
        return True
    headers = 0
    address = False
    strong = False
    for line in lines:
        match = _MAIL_LINE.match(line)
        if not match:
            continue
        headers += 1
        name = match.group(1).lower()
        value = match.group(2)
        if name in _STRONG_HEADERS:
            strong = True
        if name in _ADDRESS_HEADERS and _ADDRESS_VALUE.search(value):
            address = True
    return headers >= _MAIL_MIN and (address or strong)


def denied_content(text):
    if looks_like_mail(text) or _denied_key(text):
        return True
    return any(pattern.search(text) for pattern in _CONTENT)
