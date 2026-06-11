#!/usr/bin/env python3
"""Rebuild the updater latest.json from a release's uploaded assets.

The four matrix jobs each read-modify-write latest.json on the draft
release, so concurrent uploads can drop platform entries. This script
recreates every platform key deterministically from the asset list and
the .sig files, preserving version/notes/pub_date from the existing
latest.json when present.

Usage: fix-latest-json.py <tag> <dir-with-sigs-and-latest.json> [repo]
"""

import json
import sys
from pathlib import Path
from urllib.parse import quote

TAG = sys.argv[1]
DIR = Path(sys.argv[2])
REPO = sys.argv[3] if len(sys.argv) > 3 else "Sinotrade/shioaji-pro-app"
VERSION = TAG.lstrip("v")

# platform key -> updater artifact filename (the .sig sits next to it)
ARTIFACTS = {
    "darwin-aarch64": "Shioaji.Pro_aarch64.app.tar.gz",
    "darwin-aarch64-app": "Shioaji.Pro_aarch64.app.tar.gz",
    "darwin-x86_64": "Shioaji.Pro_x64.app.tar.gz",
    "darwin-x86_64-app": "Shioaji.Pro_x64.app.tar.gz",
    "linux-x86_64": f"Shioaji.Pro_{VERSION}_amd64.AppImage",
    "linux-x86_64-appimage": f"Shioaji.Pro_{VERSION}_amd64.AppImage",
    "linux-x86_64-deb": f"Shioaji.Pro_{VERSION}_amd64.deb",
    "linux-x86_64-rpm": f"Shioaji.Pro-{VERSION}-1.x86_64.rpm",
    "windows-x86_64": f"Shioaji.Pro_{VERSION}_x64_en-US.msi",
    "windows-x86_64-msi": f"Shioaji.Pro_{VERSION}_x64_en-US.msi",
    "windows-x86_64-nsis": f"Shioaji.Pro_{VERSION}_x64-setup.exe",
}

existing = {}
lj = DIR / "latest.json"
if lj.exists():
    existing = json.loads(lj.read_text())

platforms = {}
missing = []
for key, fname in ARTIFACTS.items():
    sig = DIR / f"{fname}.sig"
    if not sig.exists():
        missing.append(f"{key} ({fname}.sig)")
        continue
    platforms[key] = {
        "signature": sig.read_text(),
        "url": f"https://github.com/{REPO}/releases/download/{TAG}/{quote(fname)}",
    }

out = {
    "version": existing.get("version", VERSION),
    "notes": existing.get("notes", ""),
    "pub_date": existing.get("pub_date", ""),
    "platforms": platforms,
}
lj.write_text(json.dumps(out, indent=2, ensure_ascii=False))

before = sorted(existing.get("platforms", {}).keys())
after = sorted(platforms.keys())
print(f"platforms before: {len(before)} -> after: {len(after)}")
for k in after:
    mark = "+" if k not in before else " "
    print(f" {mark} {k}")
if missing:
    print("WARNING missing sigs:", ", ".join(missing))
    sys.exit(1)
