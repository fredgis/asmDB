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


HEADER_MAGIC = b"ASMCDCH1"
HEADER_TRAILER = b"CDCHEND1"
FILE_HEADER_SIZE = 64
HEADER_CRC_OFFSET = 40

FRAME_MAGIC = b"ASMCDC01"
FRAME_TRAILER = b"CDCEND01"
FRAME_HEADER_SIZE = 40
OP_SIZE = 272
FRAME_TRAILER_SIZE = 16
MIN_FRAME_SIZE = FRAME_HEADER_SIZE + FRAME_TRAILER_SIZE
MAX_OP_COUNT = 8192
RESET_FLAG = 1
KNOWN_FLAGS = RESET_FLAG


Header = dict[str, object]
Frame = dict[str, object]
Op = dict[str, object]


def decode_c_string(raw: bytes) -> str:
    """Decode a NUL-padded ASCII field."""
    return raw.rstrip(b"\x00").decode("ascii", "replace")


def parse_record(record: bytes) -> tuple[int, int, str, str]:
    """Return record id, value, tag, and content from a 256-byte row record."""
    record_id = struct.unpack_from("<Q", record, 0)[0]
    value = struct.unpack_from("<q", record, 32)[0]
    tag = decode_c_string(record[40:80])
    content = decode_c_string(record[80:256])
    return record_id, value, tag, content


def parse_op(raw: bytes, frame_offset: int) -> tuple[Op | None, str | None]:
    """Parse and validate one fixed-size CDC operation record."""
    op_type, row_id = struct.unpack_from("<QQ", raw, 0)
    record = raw[16:272]
    if op_type == 1:
        status = record[8]
        if status != 1:
            return (
                None,
                f"UPSERT record status {status} is not OCCUPIED in frame at offset "
                f"{frame_offset} (id {row_id})",
            )
        record_id, value, tag, content = parse_record(record)
        if record_id != row_id:
            return (
                None,
                f"UPSERT record id {record_id} does not match op id {row_id} "
                f"in frame at offset {frame_offset}",
            )
        return {
            "op": "UPSERT",
            "id": row_id,
            "value": value,
            "tag": tag,
            "content": content,
        }, None
    if op_type == 2:
        if record != bytes(256):
            return (
                None,
                f"DELETE record image is not zero in frame at offset {frame_offset} "
                f"(id {row_id})",
            )
        return {"op": "DELETE", "id": row_id}, None
    return None, f"bad op_type {op_type} in frame at offset {frame_offset}"


def parse_file_header(data: bytes) -> tuple[Header | None, bool, int, list[str]]:
    """Parse an optional 64-byte CDC file header."""
    if not (len(data) >= FILE_HEADER_SIZE and data[:8] == HEADER_MAGIC):
        return None, True, 0, []

    errors: list[str] = []
    cdc_format_version, record_format_version = struct.unpack_from("<II", data, 8)
    base_seq = struct.unpack_from("<Q", data, 32)[0]
    stored_crc = struct.unpack_from("<Q", data, HEADER_CRC_OFFSET)[0]
    calculated_crc = zlib.crc32(data[:HEADER_CRC_OFFSET]) & 0xFFFFFFFF
    trailer = data[56:64]

    if trailer != HEADER_TRAILER:
        errors.append("bad CDC header trailer")
    if stored_crc != calculated_crc:
        errors.append("CDC header crc mismatch")
    if cdc_format_version != 1:
        errors.append(f"unsupported CDC format version {cdc_format_version}")

    header: Header = {
        "cdc_format_version": cdc_format_version,
        "record_format_version": record_format_version,
        "lineage": data[16:32].hex(),
        "base_seq": base_seq,
    }
    return header, False, FILE_HEADER_SIZE, errors


def validate_and_parse(data: bytes) -> tuple[Header | None, bool, list[Frame], int, list[str]]:
    """Validate a .cdc byte stream and return header, frames, trailing bytes, errors."""
    header, legacy, offset, errors = parse_file_header(data)
    frames: list[Frame] = []
    if errors:
        return header, legacy, frames, 0, errors

    trailing_bytes = 0
    total_size = len(data)
    expected_seq = int(header["base_seq"]) + 1 if header is not None else 1

    while offset < total_size:
        remaining = total_size - offset
        if remaining < MIN_FRAME_SIZE:
            trailing_bytes = remaining
            break

        if data[offset : offset + 8] != FRAME_MAGIC:
            errors.append(f"bad magic at offset {offset}")
            break

        frame_size, commit_seq, op_count, flags = struct.unpack_from(
            "<QQQQ", data, offset + 8
        )
        if op_count > MAX_OP_COUNT:
            errors.append(
                f"op_count {op_count} exceeds maximum {MAX_OP_COUNT} at offset {offset}"
            )
            break
        if offset + frame_size > total_size:
            trailing_bytes = remaining
            break

        expected_size = FRAME_HEADER_SIZE + op_count * OP_SIZE + FRAME_TRAILER_SIZE
        if frame_size != expected_size:
            errors.append(
                "inconsistent frame_size at offset "
                f"{offset}: got {frame_size}, expected {expected_size}"
            )
            break

        frame_end = offset + frame_size
        crc_offset = frame_end - FRAME_TRAILER_SIZE
        stored_crc = struct.unpack_from("<Q", data, crc_offset)[0]
        trailer = data[frame_end - 8 : frame_end]
        if trailer != FRAME_TRAILER:
            errors.append(f"bad trailer in frame at offset {offset}")
            break

        calculated_crc = zlib.crc32(data[offset:crc_offset]) & 0xFFFFFFFF
        if stored_crc != calculated_crc:
            errors.append(
                f"crc mismatch in frame at offset {offset} (seq {commit_seq})"
            )
            break

        if commit_seq != expected_seq:
            errors.append(
                f"bad sequence in frame at offset {offset}: expected "
                f"{expected_seq}, got {commit_seq}"
            )
            break

        if flags & ~KNOWN_FLAGS:
            errors.append(f"unknown flags 0x{flags & ~KNOWN_FLAGS:x} at offset {offset}")
            break

        reset = bool(flags & RESET_FLAG)
        if reset and op_count != 0:
            errors.append(
                f"RESET frame at offset {offset} has op_count {op_count}, expected 0"
            )
            break

        ops: list[Op] = []
        for index in range(op_count):
            op_start = offset + FRAME_HEADER_SIZE + index * OP_SIZE
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
        expected_seq = commit_seq + 1
        offset = frame_end

    return header, legacy, frames, trailing_bytes, errors


def format_flags(flags: int) -> str:
    """Format flags for readable output."""
    if flags & RESET_FLAG:
        return "RESET"
    return "0"


def print_header(header: Header | None, legacy: bool, quiet: bool) -> None:
    """Print readable header information."""
    if quiet:
        return
    if legacy:
        print("Header: legacy=true base_seq=0")
        return
    if header is not None:
        print(
            "Header: "
            f"cdc_format_version={header['cdc_format_version']} "
            f"record_format_version={header['record_format_version']} "
            f"lineage={header['lineage']} base_seq={header['base_seq']}"
        )


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
    header: Header | None,
    legacy: bool,
    frames: list[Frame],
    from_seq: int,
    trailing_bytes: int,
    errors: list[str],
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
        "header": header,
        "legacy": legacy,
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

        header, legacy, frames, trailing_bytes, errors = validate_and_parse(data)

        if args.json:
            document = build_json_document(
                header, legacy, frames, args.from_seq, trailing_bytes, errors
            )
            print(json.dumps(document, separators=(",", ":")))
        else:
            print_header(header, legacy, args.quiet)
            print_listing(frames, args.from_seq, args.quiet)
            print(
                f"Summary: legacy={str(legacy).lower()} frames={len(frames)} "
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
