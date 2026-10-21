#!/usr/bin/env python3
"""Print one version's section of RELEASE_NOTES.md plus the shared footer.

RELEASE_NOTES.md keeps every release, newest first; each section starts
with `## vX.Y.Z - title`. The shared footer is everything after the last
`---` line (disclaimer, product line, download line). A GitHub release
body must only carry its own version, so the release workflow pipes this
script's output into `--notes-file` instead of the whole file.

Fails with a non-zero exit (and prints nothing on stdout) when the
section is missing, duplicated or empty, or when no footer can be found,
so a release never goes out with the wrong notes.

Usage: extract-release-notes.py <tag> [notes-file]   (default RELEASE_NOTES.md)
"""

import re
import sys
from pathlib import Path

HEADER = re.compile(r"^## v\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?(?:\s|$)")


class ExtractError(Exception):
    pass


def split_footer(lines):
    """Return (index of the last `---` line, footer text)."""
    seps = [i for i, line in enumerate(lines) if line.strip() == "---"]
    if not seps:
        raise ExtractError("no `---` footer separator found")
    last = seps[-1]
    footer = "\n".join(lines[last + 1 :]).strip()
    if not footer:
        raise ExtractError("footer after the last `---` is empty")
    if any(HEADER.match(line) for line in lines[last + 1 :]):
        raise ExtractError("a version section follows the last `---`; footer is ambiguous")
    return last, footer


def extract(text, tag):
    version = tag.strip()
    if not version.startswith("v"):
        version = "v" + version
    lines = text.splitlines()
    footer_at, footer = split_footer(lines)

    want = re.compile(r"^## " + re.escape(version) + r"(?:\s|$)")
    starts = [i for i, line in enumerate(lines[:footer_at]) if want.match(line)]
    if not starts:
        raise ExtractError(f"no `## {version}` section in release notes")
    if len(starts) > 1:
        raise ExtractError(f"`## {version}` appears {len(starts)} times")
    start = starts[0]

    end = footer_at
    for i in range(start + 1, footer_at):
        if HEADER.match(lines[i]):
            end = i
            break

    section = "\n".join(lines[start:end])
    # older sections carry their own copy of the footer — drop it
    cut = section.find(footer)
    if cut != -1:
        section = section[:cut]
    body = section.rstrip().splitlines()
    while body and body[-1].strip() in ("", "---"):
        body.pop()
    if len(body) < 2:
        raise ExtractError(f"`## {version}` section has no content")

    return "\n".join(body) + "\n\n---\n\n" + footer + "\n"


def main(argv):
    if len(argv) not in (2, 3):
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    tag = argv[1]
    path = Path(argv[2] if len(argv) == 3 else "RELEASE_NOTES.md")
    try:
        out = extract(path.read_text(encoding="utf-8"), tag)
    except (OSError, ExtractError) as e:
        print(f"extract-release-notes: {tag}: {e}", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(out.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
