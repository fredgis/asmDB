"""Minimal asmdb client for Python.

asmdb has no network protocol or shared library: it is a REPL that reads
commands from stdin and writes ASCII results to stdout. This client "connects"
by spawning asmdb.exe as a subprocess and piping commands to it. Because color
is disabled automatically when stdout is not a console, the captured output is
clean, plain ASCII that is easy to parse.

Usage:
    from asmdb_client import Asmdb
    db = Asmdb(r"..\\..\\build\\asmdb.exe", "MemoryDB", "notes")
    print(db.run("INSERT 1 500 alice first note", "INSERT 2 750 bob other note"))
    for row in db.select_all():
        print(row)
"""

from __future__ import annotations

import subprocess
from typing import Dict, List


class Asmdb:
    def __init__(self, exe: str, database: str, table: str | None = None) -> None:
        self.argv = [exe, database] + ([table] if table else [])

    def run(self, *commands: str) -> str:
        """Send one or more commands, then QUIT. Returns raw stdout."""
        script = "\n".join(commands) + "\nQUIT\n"
        proc = subprocess.run(
            self.argv, input=script, capture_output=True, text=True, check=True
        )
        return proc.stdout

    def select_all(self) -> List[Dict[str, object]]:
        """Run SELECT * and parse the ASCII table into a list of dicts."""
        return parse_rows(self.run("SELECT *"))


def parse_rows(output: str) -> List[Dict[str, object]]:
    """Parse asmdb's boxed SELECT output into [{id, tag, value, content}, ...]."""
    rows: List[Dict[str, object]] = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) == 4 and cells[0].lstrip("-").isdigit():
            rows.append(
                {
                    "id": int(cells[0]),
                    "tag": cells[1],
                    "value": int(cells[2]),
                    "content": cells[3].rstrip("~"),
                }
            )
    return rows


if __name__ == "__main__":
    import os

    exe = os.path.join(os.path.dirname(__file__), "..", "..", "build", "asmdb.exe")
    db = Asmdb(exe, "DemoDB", "notes")
    print(db.run(
        "BEGIN",
        "INSERT 1 500 alice first memory about alice",
        "INSERT 2 750 bob follow-up on bob",
        "COMMIT",
    ))
    for row in db.select_all():
        print(row)
