#!/usr/bin/env python3
"""Offline regression checks for reviewed license text, not legal clearance."""
import hashlib
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ProjectLicenseTests(unittest.TestCase):
    def test_apache_license_matches_reviewed_official_text(self):
        # https://www.apache.org/licenses/LICENSE-2.0.txt, reviewed 2026-10-02.
        self.assertEqual(hashlib.sha256((ROOT / "LICENSE").read_bytes()).hexdigest(),
                         "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30")

    def test_notice_keeps_project_attribution_and_separate_dependency_terms(self):
        notice = (ROOT / "NOTICE").read_text(encoding="utf-8")
        self.assertIn("Agent Mesh", notice)
        self.assertIn("Copyright 2026 Vladislav (@Vlad9572324)", notice)
        self.assertIn("Apache License, Version 2.0", notice)
        self.assertIn("Third-party components retain their own licenses", notice)
        self.assertIn("THIRD_PARTY_NOTICES.md", notice)

    def test_reviewed_go_embedded_notices_are_preserved(self):
        notices = (ROOT / "docs/third-party-notices.md").read_text(encoding="utf-8")
        for text in ("Lucent Technologies Inc.", "Vita Nuova Holdings Limited",
                     "Copyright (C) 1993 by Sun Microsystems, Inc.",
                     "Copyright (C) 2004 by Sun Microsystems, Inc.",
                     "2015-2020 The fiat-crypto Authors.",
                     "Copyright 1984, 1987, 1989, 1992, 2000 by Stephen L. Moshier"):
            with self.subTest(notice=text):
                self.assertIn(text, notices)


if __name__ == "__main__":
    unittest.main()
