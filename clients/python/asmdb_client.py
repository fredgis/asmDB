"""Minimal asmdb client for Python.

asmdb has no network protocol or shared library: it is a REPL that reads
commands from stdin and writes results to stdout. This client "connects" by
spawning asmdb as a subprocess and piping commands to it.

Usage:
    from asmdb_client import Asmdb
    db = Asmdb("MemoryDB", "notes")
    print(db.run("INSERT 1 500 alice first note", "INSERT 2 750 bob other note"))
    for row in db.select_all():
        print(row)
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List


@dataclass(frozen=True)
class Row:
    id: int
    value: int
    created: str
    updated: str
    tag: str
    content: str


def default_exe() -> str:
    env = os.environ.get("ASMDB_EXE")
    if env:
        return env
    name = "asmdb.exe" if sys.platform == "win32" else "asmdb"
    return str(Path(__file__).resolve().parents[2] / "build" / name)


class Asmdb:
    def __init__(self, database: str, table: str | None = None,
                 exe: str | None = None) -> None:
        self.argv = [exe or default_exe(), database] + ([table] if table else [])

    def run(self, *commands: str) -> str:
        """Send one or more commands, then QUIT. Returns raw stdout."""
        script = "\n".join(commands) + "\nQUIT\n"
        proc = subprocess.run(
            self.argv, input=script, capture_output=True, text=True, check=True
        )
        return proc.stdout

    def select_all(self, limit: int = 0, offset: int = 0) -> List[Row]:
        """Run SELECT * in TSV mode so content is never table-truncated."""
        return parse_tsv_rows(self.run("FORMAT TSV", f"PAGE {limit} {offset}", "SELECT *"))

    def find(self, substring: str, limit: int = 0, offset: int = 0) -> List[Row]:
        return parse_tsv_rows(
            self.run("FORMAT TSV", f"PAGE {limit} {offset}", f"FIND {substring}")
        )


def unescape_field(value: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(value):
        ch = value[i]
        if ch != "\\" or i + 1 == len(value):
            out.append(ch)
            i += 1
            continue
        nxt = value[i + 1]
        if nxt == "\\":
            out.append("\\")
        elif nxt == "t":
            out.append("\t")
        elif nxt == "n":
            out.append("\n")
        elif nxt == "r":
            out.append("\r")
        else:
            out.append("\\")
            out.append(nxt)
        i += 2
    return "".join(out)


def parse_tsv_rows(output: str) -> List[Row]:
    """Parse TSV protocol rows: R, id, value, created, updated, tag, content."""
    rows: List[Row] = []
    for raw in output.splitlines():
        if not raw.startswith("R\t"):
            continue
        fields = raw.split("\t")
        if len(fields) != 7:
            continue
        _, row_id, value, created, updated, tag, content = fields
        rows.append(
            Row(
                id=int(row_id),
                value=int(value),
                created=created,
                updated=updated,
                tag=unescape_field(tag),
                content=unescape_field(content),
            )
        )
    return rows


if __name__ == "__main__":
    db = Asmdb("DemoDB", "notes")
    print(db.run(
        "BEGIN",
        "INSERT 1 500 alice first memory about alice",
        "INSERT 2 750 bob follow-up on bob",
        "COMMIT",
    ))
    for row in db.select_all():
        print(row)
