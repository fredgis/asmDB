"""Verify and dump asmdb .cdc files.

The binary format implemented here is mirrored from src/cdc.inc and must be
kept in sync with that assembly source.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import zlib


MAGIC = b"ASMCDC01"
TRAILER = b"CDCEND01"
HEADER_SIZE = 40
OP_SIZE = 272
FRAME_TRAILER_SIZE = 16
MIN_FRAME_SIZE = HEADER_SIZE + FRAME_TRAILER_SIZE
RESET_FLAG = 1


Frame = dict[str, object]
Op = dict[str, object]


def decode_c_string(raw: bytes) -> str:
    """Decode a NUL-padded ASCII field."""
    return raw.rstrip(b"\x00").decode("ascii", "replace")


def parse_record(record: bytes) -> tuple[int, str, str]:
    """Return value, tag, and content from a 256-byte row record."""
    value = struct.unpack_from("<q", record, 32)[0]
    tag = decode_c_string(record[40:80])
    content = decode_c_string(record[80:256])
    return value, tag, content


def parse_op(raw: bytes, frame_offset: int) -> tuple[Op | None, str | None]:
    """Parse one fixed-size CDC operation record."""
    op_type, row_id = struct.unpack_from("<QQ", raw, 0)
    record = raw[16:272]
    if op_type == 1:
        value, tag, content = parse_record(record)
        return {
            "op": "UPSERT",
            "id": row_id,
            "value": value,
            "tag": tag,
            "content": content,
        }, None
    if op_type == 2:
        return {"op": "DELETE", "id": row_id}, None
    return None, f"bad op_type {op_type} in frame at offset {frame_offset}"


def validate_and_parse(data: bytes) -> tuple[list[Frame], int, list[str]]:
    """Validate a .cdc byte stream and return frames, trailing byte count, errors."""
    frames: list[Frame] = []
    errors: list[str] = []
    offset = 0
    previous_seq = 0
    trailing_bytes = 0
    total_size = len(data)

    while offset < total_size:
        remaining = total_size - offset
        if remaining < MIN_FRAME_SIZE:
            trailing_bytes = remaining
            break

        if data[offset : offset + 8] != MAGIC:
            errors.append(f"bad magic at offset {offset}")
            break

        frame_size, commit_seq, op_count, flags = struct.unpack_from(
            "<QQQQ", data, offset + 8
        )
        expected_size = HEADER_SIZE + op_count * OP_SIZE + FRAME_TRAILER_SIZE
        if frame_size != expected_size:
            errors.append(
                "inconsistent frame_size at offset "
                f"{offset}: got {frame_size}, expected {expected_size}"
            )
            break
        if offset + frame_size > total_size:
            trailing_bytes = remaining
            break

        frame_end = offset + frame_size
        crc_offset = frame_end - FRAME_TRAILER_SIZE
        stored_crc = struct.unpack_from("<Q", data, crc_offset)[0]
        trailer = data[frame_end - 8 : frame_end]
        if trailer != TRAILER:
            if frame_end == total_size:
                trailing_bytes = remaining
                break
            errors.append(f"bad trailer in frame at offset {offset}")
            break

        calculated_crc = zlib.crc32(data[offset:crc_offset]) & 0xFFFFFFFF
        if stored_crc != calculated_crc:
            errors.append(
                f"crc mismatch in frame at offset {offset} (seq {commit_seq})"
            )
            break

        if commit_seq < 1 or commit_seq <= previous_seq:
            errors.append(
                f"non-monotonic sequence in frame at offset {offset} (seq {commit_seq})"
            )
            break

        reset = bool(flags & RESET_FLAG)
        if reset and op_count != 0:
            errors.append(
                f"RESET frame at offset {offset} has op_count {op_count}, expected 0"
            )
            break

        ops: list[Op] = []
        if op_count > 0:
            for index in range(op_count):
                op_start = offset + HEADER_SIZE + index * OP_SIZE
                op, error = parse_op(data[op_start : op_start + OP_SIZE], offset)
                if error is not None:
                    errors.append(error)
                    break
                if op is not None:
                    ops.append(op)
        if errors:
            break

        frames.append(
            {
                "seq": commit_seq,
                "offset": offset,
                "size": frame_size,
                "op_count": op_count,
                "flags": flags,
                "reset": reset,
                "ops": ops,
            }
        )
        previous_seq = commit_seq
        offset = frame_end

    return frames, trailing_bytes, errors


def format_flags(flags: int) -> str:
    """Format flags for readable output."""
    parts: list[str] = []
    if flags & RESET_FLAG:
        parts.append("RESET")
    unknown = flags & ~RESET_FLAG
    if unknown:
        parts.append(f"0x{unknown:x}")
    return "|".join(parts) if parts else "0"


def print_listing(frames: list[Frame], from_seq: int, quiet: bool) -> None:
    """Print human-readable frame and operation listing."""
    if quiet:
        return
    for frame in frames:
        if int(frame["seq"]) <= from_seq:
            continue
        print(
            "Frame "
            f"seq={frame['seq']} op_count={frame['op_count']} "
            f"flags={format_flags(int(frame['flags']))} "
            f"size={frame['size']} offset={frame['offset']}"
        )
        for op in frame["ops"]:  # type: ignore[union-attr]
            if op["op"] == "UPSERT":
                print(
                    f"  UPSERT id={op['id']} value={op['value']} "
                    f"tag={op['tag']} content={op['content']}"
                )
            else:
                print(f"  DELETE id={op['id']}")


def build_json_document(
    frames: list[Frame], from_seq: int, trailing_bytes: int, errors: list[str]
) -> dict[str, object]:
    """Build the requested JSON output document."""
    visible_frames: list[dict[str, object]] = []
    for frame in frames:
        if int(frame["seq"]) <= from_seq:
            continue
        visible_frames.append(
            {
                "seq": frame["seq"],
                "offset": frame["offset"],
                "size": frame["size"],
                "reset": frame["reset"],
                "ops": frame["ops"],
            }
        )
    return {
        "frames": visible_frames,
        "last_seq": int(frames[-1]["seq"]) if frames else 0,
        "frame_count": len(frames),
        "trailing_bytes": trailing_bytes,
        "errors": errors,
    }


def check_expectations(args: argparse.Namespace, frames: list[Frame]) -> list[str]:
    """Return failed --expect-* assertion messages."""
    failures: list[str] = []
    last_seq = int(frames[-1]["seq"]) if frames else 0
    if args.expect_seq is not None and last_seq != args.expect_seq:
        failures.append(f"expected last commit_seq {args.expect_seq}, got {last_seq}")
    if args.expect_frames is not None and len(frames) != args.expect_frames:
        failures.append(f"expected {args.expect_frames} frames, got {len(frames)}")
    if args.expect_reset and (not frames or not bool(frames[-1]["reset"])):
        failures.append("expected last frame to be RESET")
    return failures


def non_negative_int(value: str) -> int:
    """argparse type for non-negative integers."""
    try:
        parsed = int(value, 10)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid integer: {value}") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError(f"must be non-negative: {value}")
    return parsed


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify and dump an asmdb .cdc change-data-capture log."
    )
    parser.add_argument("path", help="Path to the .cdc file")
    parser.add_argument("--json", action="store_true", help="Emit JSON only")
    parser.add_argument(
        "--quiet", action="store_true", help="Suppress per-frame readable listing"
    )
    parser.add_argument(
        "--from-seq",
        type=non_negative_int,
        default=0,
        help="Only show frames whose commit_seq is greater than N",
    )
    parser.add_argument(
        "--expect-seq",
        type=non_negative_int,
        help="Assert the last commit_seq equals N",
    )
    parser.add_argument(
        "--expect-frames",
        type=non_negative_int,
        help="Assert the number of complete frames equals N",
    )
    parser.add_argument(
        "--expect-reset",
        action="store_true",
        help="Assert the last complete frame is a RESET frame",
    )
    return parser.parse_args(argv)


def read_file(path: str) -> tuple[bytes | None, str | None]:
    """Read a file without raising user-visible tracebacks."""
    try:
        with open(path, "rb") as handle:
            return handle.read(), None
    except OSError as exc:
        return None, f"cannot read {path}: {exc}"


def main(argv: list[str]) -> int:
    try:
        args = parse_args(argv)
        data, read_error = read_file(args.path)
        if read_error is not None:
            print(read_error, file=sys.stderr)
            return 1
        assert data is not None

        frames, trailing_bytes, errors = validate_and_parse(data)

        if args.json:
            document = build_json_document(
                frames, args.from_seq, trailing_bytes, errors
            )
            print(json.dumps(document, separators=(",", ":")))
        else:
            print_listing(frames, args.from_seq, args.quiet)
            print(
                f"Summary: frames={len(frames)} "
                f"last_seq={int(frames[-1]['seq']) if frames else 0} "
                f"trailing_bytes={trailing_bytes} errors={len(errors)}"
            )

        if errors:
            for error in errors:
                print(error, file=sys.stderr)
            return 1

        expectation_failures = check_expectations(args, frames)
        if expectation_failures:
            for failure in expectation_failures:
                print(failure, file=sys.stderr)
            return 2

        return 0
    except BrokenPipeError:
        return 1
    except Exception as exc:  # Defensive: malformed input must not produce tracebacks.
        print(f"cdc_dump failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
