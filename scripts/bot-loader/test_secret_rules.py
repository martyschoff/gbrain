#!/usr/bin/env python3
"""Table-driven checks for every name and content pattern in secret-patterns.json."""
from __future__ import annotations

import unittest

from secret_rules import load_patterns, secret_content, secret_name


class SecretRulesTest(unittest.TestCase):
    def test_each_name_pattern_and_negatives(self):
        data = load_patterns()
        for row in data["names"]:
            self.assertTrue(secret_name(row["sample"]), row["sample"])
        for name in data["name_negatives"]:
            self.assertFalse(secret_name(name), name)

    def test_each_content_pattern_and_negatives(self):
        data = load_patterns()
        for row in data["content"]:
            self.assertTrue(secret_content(row["sample"]), row["sample"][:24])
        for text in data["content_negatives"]:
            self.assertFalse(secret_content(text), text)


if __name__ == "__main__":
    unittest.main()
