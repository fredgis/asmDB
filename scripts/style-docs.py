"""Give every document in docs/ the same header shape.

The pattern already existed in COMMANDS.md: a centred logo, an h1 and a one-line
italic subtitle, closed by a rule. Applying it everywhere makes the set read as
one manual rather than nine documents that grew separately.

The h1 text is preserved exactly as each document already had it. Only the
presentation changes, and the first paragraph of prose is left untouched.
"""

from pathlib import Path
import re

DOCS = Path(__file__).resolve().parents[1] / "docs"

SUBTITLES = {
    "CDC.md": "The change-log format, and how a consumer follows it without losing a row.",
    "COST.md": "Every Azure rate, the arithmetic behind each price, and the ways the model breaks.",
    "ENGINE.md": "The byte-level reference: layouts, calling convention, hashing, durability, ACID.",
    "MULTITENANCY.md": "How one control plane serves many customers, where the boundaries sit, and what private networking costs.",
    "SAAS.md": "The hosted platform as deployed: resources, request paths, identity, instance lifecycle.",
    "SBOM.md": "What this repository depends on, and what it deliberately does not.",
    "SECURITY.md": "The posture as it stands today, including the gaps, stated rather than implied.",
    "WORKLOAD.md": "The Fabric workload: design, contracts, and what was got wrong on the way.",
}

HEADER = """<div align="center">
  <img src="assets/asmdb-logo.png" alt="asmdb logo" width="110">

  <h1>{title}</h1>

  <p><em>{subtitle}</em></p>
</div>

---
"""


def already_styled(text: str) -> bool:
    return text.lstrip().startswith('<div align="center">')


def main() -> None:
    for path in sorted(DOCS.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        if already_styled(text):
            print(f"skip   {path.name} (already styled)")
            continue

        match = re.match(r"^#\s+(.+?)\n+", text)
        if not match:
            print(f"SKIP   {path.name} (no leading h1)")
            continue

        title = match.group(1).strip()
        subtitle = SUBTITLES.get(path.name)
        if not subtitle:
            print(f"SKIP   {path.name} (no subtitle defined)")
            continue

        body = text[match.end():]
        # The h1 is replaced by the block, so drop a rule that immediately
        # followed it rather than emitting two in a row.
        body = re.sub(r"^-{3,}\n+", "", body)
        path.write_text(HEADER.format(title=title, subtitle=subtitle) + "\n" + body, encoding="utf-8")
        print(f"styled {path.name}")


if __name__ == "__main__":
    main()
