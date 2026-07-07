#!/usr/bin/env python3
"""Lightweight structural checks for the Acpus Skill.

Usage:
  python scripts/verify-skill.py .
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

NAME_RE = re.compile(r"^[a-z0-9-]{1,64}$")
LINK_RE = re.compile(r"`((?:references|assets|scripts)/[^`]+)`")


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        fail("SKILL.md must start with YAML frontmatter")
    end = text.find("\n---", 4)
    if end == -1:
        fail("SKILL.md frontmatter is not closed")
    raw = text[4:end].strip().splitlines()
    body = text[end + len("\n---") :]
    fields: dict[str, str] = {}
    for line in raw:
        if not line.strip():
            continue
        if ":" not in line:
            fail(f"invalid frontmatter line: {line!r}")
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip().strip('"').strip("'")
    return fields, body


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path(".")
    skill = root / "SKILL.md"
    if not skill.exists():
        fail(f"missing {skill}")

    text = skill.read_text(encoding="utf-8")
    fields, body = parse_frontmatter(text)

    name = fields.get("name", "")
    description = fields.get("description", "")

    if not NAME_RE.match(name):
        fail("frontmatter name must be lowercase letters, numbers, hyphens, max 64 chars")
    if not description:
        fail("frontmatter description is required")
    if len(description) > 1024:
        fail("frontmatter description exceeds 1024 characters")
    if "<" in name or ">" in name or "<" in description or ">" in description:
        fail("frontmatter must not contain XML-like tags")
    if len(body.splitlines()) > 500:
        fail("SKILL.md body exceeds 500 lines")

    missing: list[str] = []
    for link in sorted(set(LINK_RE.findall(text))):
        if not (root / link).exists():
            missing.append(link)
    if missing:
        fail("missing linked files: " + ", ".join(missing))

    print("Skill structure looks OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
