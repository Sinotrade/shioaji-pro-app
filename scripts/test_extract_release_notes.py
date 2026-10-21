"""Tests for extract-release-notes.py.

Run: python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "extract-release-notes.py"
NOTES = HERE.parent / "RELEASE_NOTES.md"

_spec = importlib.util.spec_from_file_location("extract_release_notes", SCRIPT)
ern = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ern)

FOOTER = "⚠ disclaimer line\n\nShioaji Pro 桌面版 - tagline\n\n下載：macOS `.dmg`"

SAMPLE = f"""## v1.2.10 - newest

- ten

---

## v1.2.1 - older

- one

---

{FOOTER}
## v1.2.0 - oldest

- zero

---

{FOOTER}
"""


class ExtractSample(unittest.TestCase):
    def test_newest_only(self):
        out = ern.extract(SAMPLE, "v1.2.10")
        self.assertTrue(out.startswith("## v1.2.10 - newest\n\n- ten\n\n---\n\n⚠"))
        self.assertNotIn("v1.2.1 ", out)
        self.assertTrue(out.endswith(FOOTER + "\n"))

    def test_prefix_version_not_matched(self):
        out = ern.extract(SAMPLE, "v1.2.1")
        self.assertTrue(out.startswith("## v1.2.1 - older"))
        self.assertNotIn("ten", out)

    def test_embedded_footer_not_duplicated(self):
        for tag in ("v1.2.1", "v1.2.0"):
            out = ern.extract(SAMPLE, tag)
            self.assertEqual(out.count("⚠"), 1, tag)
            self.assertEqual(out.count("\n---\n"), 1, tag)

    def test_tag_without_v(self):
        self.assertEqual(ern.extract(SAMPLE, "1.2.0"), ern.extract(SAMPLE, "v1.2.0"))

    def test_missing_section_fails(self):
        with self.assertRaises(ern.ExtractError):
            ern.extract(SAMPLE, "v9.9.9")
        with self.assertRaises(ern.ExtractError):
            ern.extract(SAMPLE, "main")

    def test_duplicate_section_fails(self):
        text = "## v1.0.0 - a\n\n- x\n\n## v1.0.0 - b\n\n- y\n\n---\n\nfooter\n"
        with self.assertRaises(ern.ExtractError):
            ern.extract(text, "v1.0.0")

    def test_no_footer_fails(self):
        with self.assertRaises(ern.ExtractError):
            ern.extract("## v1.0.0 - a\n\n- x\n", "v1.0.0")

    def test_cli_missing_exits_nonzero_with_empty_stdout(self):
        r = subprocess.run(
            [sys.executable, str(SCRIPT), "v0.0.0-nope", str(NOTES)],
            capture_output=True,
        )
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout, b"")
        self.assertIn(b"v0.0.0-nope", r.stderr)


@unittest.skipUnless(NOTES.exists(), "RELEASE_NOTES.md not present")
class ExtractRealNotes(unittest.TestCase):
    TAGS = ("v0.1.55", "v0.1.54", "v0.1.53")

    @classmethod
    def setUpClass(cls):
        cls.text = NOTES.read_text(encoding="utf-8")
        cls.headers = [l for l in cls.text.splitlines() if ern.HEADER.match(l)]

    def test_each_release_has_only_its_section_and_footer(self):
        for tag in self.TAGS:
            with self.subTest(tag=tag):
                out = ern.extract(self.text, tag)
                own = [h for h in self.headers if h.startswith(f"## {tag} ")]
                self.assertEqual(len(own), 1)
                self.assertTrue(out.startswith(own[0] + "\n"))
                others = [h for h in self.headers if h != own[0] and h in out]
                self.assertEqual(others, [], f"{tag} leaked {others}")
                self.assertEqual(out.count("⚠ Agent 分析"), 1)
                self.assertEqual(out.count("Shioaji Pro 桌面版"), 1)
                self.assertEqual(out.count("\n下載："), 1)
                self.assertTrue(out.rstrip().endswith("`.rpm`"))

    def test_cli_matches_function(self):
        for tag in self.TAGS:
            with self.subTest(tag=tag):
                r = subprocess.run(
                    [sys.executable, str(SCRIPT), tag, str(NOTES)],
                    capture_output=True,
                    check=True,
                )
                self.assertEqual(r.stdout.decode("utf-8"), ern.extract(self.text, tag))


if __name__ == "__main__":
    unittest.main()
