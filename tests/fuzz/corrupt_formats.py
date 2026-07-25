#!/usr/bin/env python3
"""Bounded on-disk format corruption checks for asmdb.

The harness creates a small valid database with the engine, copies its .dat,
.wal and .cdc files, applies seeded corruptions that should be detectable, then
opens the copy and runs VERIFY. A trial fails only when damaged input is
reported as fully healthy.
"""

from __future__ import annotations

import argparse
import os
import random
import shutil
import struct
import subprocess
import sys
from pathlib import Path
import zlib


ROOT = Path(__file__).resolve().parents[2]
WORK = Path(__file__).resolve().parent / ".fuzz-run"
HEADER_SIZE = 512
REC_SIZE = 256
REC_STATUS = 8
GOLDEN = 0x9E3779B97F4A7C15
CAP_SHIFT = 42
WAL_MARKER = b"COMMIT01"


def default_engine() -> Path:
    name = "asmdb.exe" if os.name == "nt" else "asmdb"
    return ROOT / "build" / name


def slot_index(key: int) -> int:
    return ((key * GOLDEN) & 0xFFFFFFFFFFFFFFFF) >> CAP_SHIFT


def run_engine(engine: Path, db: Path, script: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(engine), str(db)],
        input=script,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(cwd),
        timeout=20,
        check=False,
    )


def create_baseline(engine: Path) -> Path:
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)
    base = WORK / "baseline" / "fuzzdb"
    base.parent.mkdir()
    script = "\n".join(
        [
            "INSERT 1 10 alpha first row",
            "INSERT 2 20 beta second row",
            "INSERT 3 30 gamma third row",
            "VERIFY",
            "EXIT",
            "",
        ]
    )
    proc = run_engine(engine, base, script, base.parent)
    out = proc.stdout + proc.stderr
    if proc.returncode != 0 or "[ OK ] verify:" not in out:
        raise RuntimeError(f"failed to create valid baseline\n{out}")
    for suffix in (".dat", ".wal", ".cdc"):
        path = base.with_suffix(suffix)
        if not path.exists():
            raise RuntimeError(f"engine did not create {path.name}")
    return base


def copy_case(base: Path, case_dir: Path) -> Path:
    if case_dir.exists():
        shutil.rmtree(case_dir)
    case_dir.mkdir()
    db = case_dir / "fuzzdb"
    src_dat = base.with_suffix(".dat")
    dst_dat = db.with_suffix(".dat")
    with src_dat.open("rb") as src, dst_dat.open("w+b") as dst:
        dst.truncate(src_dat.stat().st_size)
        src.seek(0)
        dst.write(src.read(HEADER_SIZE))
        for row_id in (1, 2, 3):
            off = HEADER_SIZE + slot_index(row_id) * REC_SIZE
            src.seek(off)
            chunk = src.read(REC_SIZE)
            dst.seek(off)
            dst.write(chunk)
    for suffix in (".wal", ".cdc"):
        shutil.copy2(base.with_suffix(suffix), db.with_suffix(suffix))
    return db


def xor_byte(path: Path, offset: int, mask: int = 0x55) -> None:
    with path.open("r+b") as f:
        f.seek(offset)
        b = f.read(1)
        if not b:
            raise ValueError(f"{path.name} too short for offset {offset}")
        f.seek(offset)
        f.write(bytes([b[0] ^ mask]))


def write_u64(path: Path, offset: int, value: int) -> None:
    with path.open("r+b") as f:
        f.seek(offset)
        f.write(struct.pack("<Q", value))


def truncate(path: Path, size: int) -> None:
    with path.open("r+b") as f:
        f.truncate(size)


def live_status_offset(row_id: int) -> int:
    return HEADER_SIZE + slot_index(row_id) * REC_SIZE + REC_STATUS


def make_bad_wal_v2(path: Path) -> None:
    """Append a committed v02 WAL frame with an intentionally bad checksum."""
    rec = bytearray(REC_SIZE)
    struct.pack_into("<Q", rec, 0, 99)
    rec[REC_STATUS] = 1
    struct.pack_into("<I", rec, 12, len(b"bad wal"))
    struct.pack_into("<q", rec, 16, 1)
    struct.pack_into("<q", rec, 24, 1)
    struct.pack_into("<q", rec, 32, 99)
    rec[40:43] = b"wal"
    rec[80:87] = b"bad wal"
    buf = bytearray()
    buf += b"ASMWAL02"
    buf += struct.pack("<Q", 1)
    buf += struct.pack("<Q", 4)
    buf += struct.pack("<Q", slot_index(99))
    buf += rec
    marker_at = len(buf)
    buf += WAL_MARKER
    crc = zlib.crc32(bytes(buf[:marker_at])) & 0xFFFFFFFF
    buf += struct.pack("<Q", crc)
    buf[marker_at - 1] ^= 0x01
    path.write_bytes(buf)


def cdc_frame_info(path: Path) -> tuple[int, int, int]:
    data = path.read_bytes()
    if len(data) < 64 + 56:
        raise ValueError("CDC file too short")
    frame = 64
    frame_size = struct.unpack_from("<Q", data, frame + 8)[0]
    if frame_size < 56 or frame + frame_size > len(data):
        raise ValueError("CDC frame size invalid in baseline")
    crc_off = frame + frame_size - 16
    trailer_off = frame + frame_size - 8
    return frame, crc_off, trailer_off


def mutate(db: Path, rng: random.Random) -> str:
    dat = db.with_suffix(".dat")
    wal = db.with_suffix(".wal")
    cdc = db.with_suffix(".cdc")
    frame, cdc_crc, cdc_trailer = cdc_frame_info(cdc)
    actions = [
        ("dat-header-magic", lambda: xor_byte(dat, 0)),
        ("dat-storage-format", lambda: xor_byte(dat, 8)),
        ("dat-live-count", lambda: write_u64(dat, 24, 999)),
        ("dat-bad-status", lambda: xor_byte(dat, live_status_offset(2), 0x08)),
        ("dat-truncated-header", lambda: truncate(dat, 128)),
        ("dat-truncated-slot", lambda: truncate(dat, live_status_offset(3))),
        ("wal-bad-committed-crc", lambda: make_bad_wal_v2(wal)),
        ("cdc-header-magic", lambda: xor_byte(cdc, 0)),
        ("cdc-header-crc", lambda: xor_byte(cdc, 40)),
        ("cdc-header-trailer", lambda: xor_byte(cdc, 56)),
        ("cdc-frame-magic", lambda: xor_byte(cdc, frame)),
        ("cdc-frame-crc", lambda: xor_byte(cdc, cdc_crc)),
        ("cdc-frame-trailer", lambda: xor_byte(cdc, cdc_trailer)),
    ]
    name, fn = rng.choice(actions)
    fn()
    return name


def acceptable(proc: subprocess.CompletedProcess[str]) -> tuple[bool, str]:
    out = proc.stdout + proc.stderr
    if "[ERR]" in out:
        return True, "clean refusal/error"
    if "[ERR] verify:" in out:
        return True, "VERIFY reported damage"
    if proc.returncode != 0:
        return False, f"process failed without [ERR] (exit {proc.returncode})"
    if "[ OK ] verify:" in out:
        return False, "damaged database reported healthy"
    return False, "no error or VERIFY verdict found"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", type=Path, default=default_engine())
    ap.add_argument("--iterations", type=int, default=200)
    ap.add_argument("--seed", type=int, default=None)
    args = ap.parse_args()

    seed = args.seed if args.seed is not None else random.randrange(1 << 32)
    rng = random.Random(seed)
    print(f"[fuzz] seed={seed} iterations={args.iterations} engine={args.engine}")

    if not args.engine.exists():
        print(f"[fuzz] engine not found: {args.engine}", file=sys.stderr)
        return 2

    base = create_baseline(args.engine.resolve())
    failures: list[str] = []
    for i in range(args.iterations):
        db = copy_case(base, WORK / f"case-{i:04d}")
        mutation = mutate(db, rng)
        proc = run_engine(args.engine.resolve(), db, "VERIFY\nEXIT\n", db.parent)
        ok, why = acceptable(proc)
        if not ok:
            failures.append(
                f"iteration={i} mutation={mutation} reason={why}\n"
                f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
            )
            break
    if failures:
        print("[fuzz] FAILED")
        print(failures[0])
        return 1
    print("[fuzz] OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
