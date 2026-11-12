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

    def test_export_deny_names_and_content(self):
        from export_deny import denied_content, denied_name
        self.assertTrue(denied_name("holdings.csv"))
        self.assertFalse(denied_name("memory.md"))
        self.assertFalse(denied_name("profile.json"))
        self.assertTrue(denied_content("reach " + "ada" + "@" + "example.com"))
        self.assertTrue(denied_content("call " + "555" + "-" + "010" + "-" + "0199"))
        self.assertTrue(denied_content("4242" * 4))
        self.assertTrue(denied_content("account " + "000000000000"))
        self.assertTrue(denied_content("9" + " Example " + "Road"))
        self.assertTrue(denied_content("9" + " Example " + "Place"))
        self.assertTrue(denied_content("call " + "555" + "." + "010" + "." + "0199"))
        self.assertTrue(denied_content("call +1 " + "555" + " " + "010" + " " + "0199"))
        self.assertTrue(denied_content("ssn " + "000" + "-" + "00" + "-" + "0000"))
        self.assertTrue(denied_content("password: " + "not-a-real-value"))
        self.assertFalse(denied_content("password policy lives in the handbook"))
        self.assertTrue(denied_content("api_key=" + "not-a-real-value"))
        self.assertFalse(denied_content("api_key: SEE_HANDBOOK"))
        self.assertTrue(denied_name("brokerage.csv"))
        self.assertFalse(denied_content("We talked about brokerage fees yesterday."))
        self.assertFalse(denied_content("the tax-lot method is FIFO"))
        self.assertFalse(denied_content("The api key is rotated quarterly."))
        self.assertTrue(denied_content("The holdings list stays offline."))
        self.assertFalse(denied_content("We are holding the meeting on Friday."))
        self.assertFalse(denied_content("9 items in place."))
        self.assertTrue(denied_content("From: ada\nSubject: hello\n\nA note.\n"))
        self.assertTrue(denied_content("To: alice-example\nDate: Thu, 12 Nov 2026 02:00:00 -0500\n\nA note.\n"))
        self.assertTrue(denied_content("Received: by mail.example.test\nMessage-ID: <fake.1>\n\nA note.\n"))
        self.assertFalse(denied_content("Subject: weekly plan\n\nOrdinary notes from the meeting.\n"))
        self.assertFalse(denied_content("Date: Thursday\nSubject: weekly plan\n\nBring the notes.\n"))
        self.assertFalse(denied_content("---\nfrom: weekly\ndate: 2026-11-12\n---\nNotes about the plan.\n"))
        self.assertFalse(denied_content("From the hill the path was clear.\nSubject matter stays in the notes.\n"))
        self.assertFalse(denied_content("A fake fact from yesterday."))
        self.assertFalse(denied_content("Meet at 2 AM."))


if __name__ == "__main__":
    unittest.main()
