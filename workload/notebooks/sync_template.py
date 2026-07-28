# %% [markdown]
# # asmDB -> Fabric Delta sync notebook
#
# This notebook is generated per sync link. It reads asmDB CDC frames from the
# workload CDC gateway, applies a decoder to the `content` field, and commits
# the target Delta table and its CDC watermark together.
#
# The pure Python functions at the top are intentionally free of Spark/Fabric
# dependencies so a sceptical operator can test the CDC semantics without a
# workspace.

# %%
from __future__ import annotations

import base64
import binascii
import csv
import io
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlencode

WATERMARK_PROPERTY = "asmdb.cdc.watermark"

# Values between __ASMDB_*__ markers are replaced by render.py.
GATEWAY_URL = "__ASMDB_GATEWAY_URL__"
INSTANCE_ID = "__ASMDB_INSTANCE_ID__"
TARGET_TABLE = "__ASMDB_TARGET_TABLE__"
KEY_VAULT_URL = "__ASMDB_KEY_VAULT_URL__"
KEY_VAULT_SECRET_NAME = "__ASMDB_KEY_VAULT_SECRET_NAME__"
DECODER = "None"  # None, Hex, Base64, JSON, CSV, MessagePack
DECODER_CONFIG: Dict[str, Any] = {}
PAGE_LIMIT = 5000
HARD_DELETE = False
ACK_PATH_TEMPLATE = "/cdc/{instance_id}/ack"


class SyncError(RuntimeError):
    """Base class for sync failures that should be surfaced by the workload UI."""


class TransientGatewayError(SyncError):
    """CDC gateway is temporarily unable to read the asmDB share."""


class FullReloadUnavailable(SyncError):
    """The CDC log no longer contains enough history to rebuild the table."""


@dataclass(frozen=True)
class ReseedRequired(SyncError):
    reason: str
    detail: Mapping[str, Any]

    def __str__(self) -> str:
        return f"full reseed required: {self.reason}: {dict(self.detail)}"


@dataclass(frozen=True)
class ParsedNdjson:
    frames: List[Dict[str, Any]]
    ignored_torn_last_line: bool = False


def parse_ndjson(text: str) -> ParsedNdjson:
    """Parse complete NDJSON lines, ignoring one unterminated torn tail.

    A gateway may stop before a final newline if the transport is cut. Complete
    malformed lines are errors; only an invalid final line without a trailing
    newline is treated as a torn tail and ignored.
    """

    frames: List[Dict[str, Any]] = []
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        is_last = index == len(lines) - 1
        is_terminated = line.endswith("\n") or line.endswith("\r")
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError:
            if is_last and not is_terminated:
                return ParsedNdjson(frames=frames, ignored_torn_last_line=True)
            raise
        if not isinstance(value, dict):
            raise ValueError("each NDJSON line must be a JSON object")
        frames.append(value)
    return ParsedNdjson(frames=frames, ignored_torn_last_line=False)


def classify_gateway_response(status_code: int, body: str) -> ParsedNdjson:
    if status_code == 409:
        payload = json.loads(body)
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        code = error.get("code")
        if code in ("cdc_gap", "cdc_corrupt"):
            raise ReseedRequired(code, error)
    if status_code == 503:
        raise TransientGatewayError(f"CDC gateway temporarily unreadable: {body[:500]}")
    if status_code < 200 or status_code >= 300:
        raise SyncError(f"CDC gateway returned HTTP {status_code}: {body[:500]}")
    return parse_ndjson(body)


def require_incremental_frames(frames: Sequence[Mapping[str, Any]]) -> None:
    for frame in frames:
        flags = frame.get("flags") or {}
        if bool(flags.get("reset")):
            raise ReseedRequired("reset_frame", {"commitSeq": frame.get("commitSeq"), "flags": flags})


def _to_int_or_none(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    return int(value)


def _millis_to_iso(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    millis = int(value)
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _decode_utf8(data: bytes) -> str:
    return data.decode("utf-8")


def _decode_msgpack_minimal(data: bytes) -> Any:
    """Small MessagePack reader for tests/notebook fallback.

    If msgpack is installed the public decoder uses it. This fallback supports
    nil/bool/ints/floats/str/bin/arrays/maps, which is enough for common content
    payloads and avoids making unit tests depend on Spark or third-party wheels.
    """

    def read(pos: int) -> Tuple[Any, int]:
        if pos >= len(data):
            raise ValueError("unexpected end of MessagePack payload")
        b = data[pos]
        pos += 1
        if b <= 0x7F:
            return b, pos
        if 0x80 <= b <= 0x8F:
            size = b & 0x0F
            result = {}
            for _ in range(size):
                key, pos = read(pos)
                val, pos = read(pos)
                result[key] = val
            return result, pos
        if 0x90 <= b <= 0x9F:
            size = b & 0x0F
            arr = []
            for _ in range(size):
                val, pos = read(pos)
                arr.append(val)
            return arr, pos
        if 0xA0 <= b <= 0xBF:
            size = b & 0x1F
            raw = data[pos : pos + size]
            if len(raw) != size:
                raise ValueError("truncated MessagePack string")
            return raw.decode("utf-8"), pos + size
        if b == 0xC0:
            return None, pos
        if b == 0xC2:
            return False, pos
        if b == 0xC3:
            return True, pos
        if b in (0xCC, 0xCD, 0xCE, 0xCF):
            sizes = {0xCC: 1, 0xCD: 2, 0xCE: 4, 0xCF: 8}
            size = sizes[b]
            raw = data[pos : pos + size]
            if len(raw) != size:
                raise ValueError("truncated MessagePack integer")
            return int.from_bytes(raw, "big", signed=False), pos + size
        if b in (0xD0, 0xD1, 0xD2, 0xD3):
            sizes = {0xD0: 1, 0xD1: 2, 0xD2: 4, 0xD3: 8}
            size = sizes[b]
            raw = data[pos : pos + size]
            if len(raw) != size:
                raise ValueError("truncated MessagePack integer")
            return int.from_bytes(raw, "big", signed=True), pos + size
        if b in (0xD9, 0xDA, 0xDB):
            len_sizes = {0xD9: 1, 0xDA: 2, 0xDB: 4}
            len_size = len_sizes[b]
            size = int.from_bytes(data[pos : pos + len_size], "big")
            pos += len_size
            raw = data[pos : pos + size]
            if len(raw) != size:
                raise ValueError("truncated MessagePack string")
            return raw.decode("utf-8"), pos + size
        if b in (0xC4, 0xC5, 0xC6):
            len_sizes = {0xC4: 1, 0xC5: 2, 0xC6: 4}
            len_size = len_sizes[b]
            size = int.from_bytes(data[pos : pos + len_size], "big")
            pos += len_size
            raw = data[pos : pos + size]
            if len(raw) != size:
                raise ValueError("truncated MessagePack binary")
            return raw, pos + size
        if 0xE0 <= b <= 0xFF:
            return b - 0x100, pos
        raise ValueError(f"unsupported MessagePack marker 0x{b:02x}")

    value, end = read(0)
    if end != len(data):
        raise ValueError("trailing bytes after MessagePack payload")
    return value


def _flatten_decoded(value: Any, prefix: str = "content") -> Dict[str, Any]:
    if isinstance(value, dict):
        return {f"{prefix}_{str(k)}": v for k, v in value.items()}
    return {f"{prefix}_decoded": value}


def decode_content(raw: Optional[str], decoder: str = "None", config: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    config = config or {}
    result: Dict[str, Any] = {"content_raw": raw, "_decode_error": None}
    if raw is None or decoder in (None, "", "None"):
        return result

    try:
        if decoder == "Hex":
            result["content_decoded"] = _decode_utf8(bytes.fromhex(raw))
        elif decoder == "Base64":
            result["content_decoded"] = _decode_utf8(base64.b64decode(raw, validate=True))
        elif decoder == "JSON":
            result.update(_flatten_decoded(json.loads(raw)))
        elif decoder == "CSV":
            row = next(csv.reader(io.StringIO(raw), strict=True))
            columns = list(config.get("columns") or [f"csv_{i}" for i in range(len(row))])
            result.update({f"content_{name}": row[i] if i < len(row) else None for i, name in enumerate(columns)})
            if len(row) > len(columns):
                for i in range(len(columns), len(row)):
                    result[f"content_csv_{i}"] = row[i]
        elif decoder == "MessagePack":
            try:
                payload = base64.b64decode(raw, validate=True)
            except binascii.Error:
                payload = raw.encode("latin1")
            try:
                import msgpack  # type: ignore

                decoded = msgpack.unpackb(payload, raw=False)
            except ImportError:
                decoded = _decode_msgpack_minimal(payload)
            result.update(_flatten_decoded(decoded))
        else:
            raise ValueError(f"unknown content decoder: {decoder}")
    except Exception as exc:  # keep the row; mark the interpretation failure
        result["_decode_error"] = f"{type(exc).__name__}: {exc}"
    return result


def row_from_op(op: Mapping[str, Any], commit_seq: int, decoder: str = "None", config: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    op_type = op.get("op")
    row: Dict[str, Any] = {
        "id": int(op["id"]),
        "value": None,
        "tag": None,
        "content_raw": None,
        "created": None,
        "updated": None,
        "_commit_seq": commit_seq,
        "_deleted": op_type == "delete",
        "_decode_error": None,
        "_synced_at": None,
    }
    if op_type == "delete":
        return row
    if op_type != "upsert":
        raise ValueError(f"unknown CDC op: {op_type}")

    record = op.get("record") or {}
    decoded = decode_content(record.get("content"), decoder=decoder, config=config)
    row.update(
        {
            "id": int(record.get("id", op["id"])),
            "value": _to_int_or_none(record.get("value")),
            "tag": record.get("tag"),
            "created": _millis_to_iso(record.get("created")),
            "updated": _millis_to_iso(record.get("updated")),
            "_deleted": False,
        }
    )
    row.update(decoded)
    return row


def collapse_frames(frames: Sequence[Mapping[str, Any]], decoder: str = "None", config: Optional[Mapping[str, Any]] = None) -> Tuple[List[Dict[str, Any]], int]:
    """Return one row per id, where the last operation in commit order wins."""

    require_incremental_frames(frames)
    collapsed: Dict[int, Dict[str, Any]] = {}
    watermark = 0
    for frame in frames:
        commit_seq = int(frame["commitSeq"])
        watermark = max(watermark, commit_seq)
        for op in frame.get("ops") or []:
            row = row_from_op(op, commit_seq, decoder=decoder, config=config)
            collapsed[int(row["id"])] = row
    return list(collapsed.values()), watermark


def fold_rebuild_frames(
    frames: Sequence[Mapping[str, Any]],
    base_seq: int,
    decoder: str = "None",
    config: Optional[Mapping[str, Any]] = None,
) -> Tuple[List[Dict[str, Any]], int]:
    """Rebuild a complete table image by replaying the retained CDC log.

    This is only honest when the log still reaches the beginning of history.
    If retention has trimmed earlier frames, rebuilding from the retained base
    would silently omit old live rows.
    """

    if base_seq > 0:
        raise FullReloadUnavailable(
            f"full reload cannot rebuild a complete table because the CDC log starts at baseSeq={base_seq}; "
            "the early frames have been trimmed"
        )

    image: Dict[int, Dict[str, Any]] = {}
    watermark = 0
    for frame in frames:
        commit_seq = int(frame["commitSeq"])
        watermark = max(watermark, commit_seq)
        flags = frame.get("flags") or {}
        if bool(flags.get("reset")):
            image.clear()
        for op in frame.get("ops") or []:
            op_type = op.get("op")
            op_id = int(op["id"])
            if op_type == "delete":
                image.pop(op_id, None)
            elif op_type == "upsert":
                row = row_from_op(op, commit_seq, decoder=decoder, config=config)
                row["_deleted"] = False
                image[int(row["id"])] = row
            else:
                raise ValueError(f"unknown CDC op: {op_type}")
    return list(image.values()), watermark


def incremental_write_plan(has_data_changes: bool) -> Tuple[str, ...]:
    """Return the only safe order for sync writes.

    The watermark must never be written before the data it describes. If Spark
    crashes after data and before watermark, the stale watermark replays this
    idempotent operation. If it crashes after watermark and before data, the
    next run skips missing rows, which is silent data loss.
    """

    return ("merge_data", "write_watermark") if has_data_changes else ("write_watermark",)


def rebuild_write_plan() -> Tuple[str, ...]:
    return ("replace_data", "write_watermark")


# %% [markdown]
# ## Fabric/Spark shell
# Everything below this point expects to run inside a Fabric Spark notebook.

# %%
def get_gateway_token(vault_url: str, secret_name: str) -> str:
    try:
        return notebookutils.credentials.getSecret(vault_url, secret_name)  # type: ignore[name-defined]
    except NameError as exc:
        raise SyncError(
            "notebookutils is unavailable. This notebook must run inside a "
            "Microsoft Fabric Spark session."
        ) from exc


def fetch_cdc_page(
    gateway_url: str,
    instance_id: str,
    token: str,
    from_seq: int,
    limit: int,
    max_attempts: int = 4,
    initial_backoff_seconds: float = 2.0,
) -> Tuple[List[Dict[str, Any]], Mapping[str, str]]:
    import requests

    url = gateway_url.rstrip("/") + f"/cdc/{instance_id}?" + urlencode({"from": str(from_seq), "limit": str(limit)})
    attempt = 1
    backoff = initial_backoff_seconds
    while True:
        response = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/x-ndjson"},
            timeout=60,
        )
        try:
            parsed = classify_gateway_response(response.status_code, response.text)
            return parsed.frames, response.headers
        except TransientGatewayError:
            if attempt >= max_attempts:
                raise
            print(
                f"WARNING: CDC gateway returned 503 for from={from_seq}; "
                f"retrying in {backoff:g}s (attempt {attempt + 1}/{max_attempts})"
            )
            time.sleep(backoff)
            attempt += 1
            backoff *= 2


def acknowledge_watermark(gateway_url: str, instance_id: str, token: str, watermark: int) -> bool:
    import requests

    path = ACK_PATH_TEMPLATE.format(instance_id=instance_id)
    url = gateway_url.rstrip("/") + path
    try:
        response = requests.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            data=json.dumps({"watermark": str(watermark)}),
            timeout=30,
        )
    except Exception as exc:
        print(f"WARNING: watermark {watermark} was committed locally but gateway acknowledge failed: {exc}")
        return False
    if response.status_code < 200 or response.status_code >= 300:
        print(
            f"WARNING: watermark {watermark} was committed locally but gateway acknowledge returned "
            f"HTTP {response.status_code}: {response.text[:500]}"
        )
        return False
    return True


def table_exists(spark_session: Any, table_name: str) -> bool:
    try:
        spark_session.table(table_name).limit(0).count()
        return True
    except Exception:
        return False


def read_watermark(spark_session: Any, table_name: str) -> int:
    if not table_exists(spark_session, table_name):
        return 0
    detail = spark_session.sql(f"DESCRIBE DETAIL {table_name}").select("properties").first()
    properties = detail["properties"] if detail else {}
    value = (properties or {}).get(WATERMARK_PROPERTY)
    return int(value) if value not in (None, "") else 0


def _header_int(headers: Mapping[str, str], name: str, default: int = 0) -> int:
    for key, value in headers.items():
        if key.lower() == name.lower():
            return int(value)
    return default


def _quote_sql_string(value: str) -> str:
    return value.replace("'", "''")


def write_watermark_property(spark_session: Any, table_name: str, watermark: int) -> None:
    spark_session.sql(
        f"ALTER TABLE {table_name} SET TBLPROPERTIES ('{WATERMARK_PROPERTY}' = '{_quote_sql_string(str(watermark))}')"
    )


def apply_incremental_rows(spark_session: Any, table_name: str, rows: Sequence[Mapping[str, Any]], watermark: int, hard_delete: bool = False) -> None:
    """Apply changed rows incrementally, then advance the Delta table watermark.

    Invariant: data is written before the watermark property, never the reverse.
    A crash after MERGE but before ALTER TABLE only replays the same idempotent
    batch. A crash after watermark-before-data would skip rows permanently.
    """

    plan = incremental_write_plan(has_data_changes=bool(rows))
    if plan and plan[0] == "write_watermark":
        if table_exists(spark_session, table_name):
            write_watermark_property(spark_session, table_name, watermark)
        return

    from pyspark.sql import functions as F

    staged = changes_dataframe(spark_session, rows).withColumn("_synced_at", F.current_timestamp())
    staged.createOrReplaceTempView("__asmdb_changes")

    if not table_exists(spark_session, table_name):
        initial = staged.filter(~F.col("_deleted")) if hard_delete else staged
        initial.writeTo(table_name).using("delta").create()
        write_watermark_property(spark_session, table_name, watermark)
        return

    if hard_delete:
        spark_session.sql(
            f"""
            MERGE INTO {table_name} AS target
            USING __asmdb_changes AS source
            ON target.id = source.id
            WHEN MATCHED AND source._deleted = true THEN DELETE
            WHEN MATCHED THEN UPDATE SET *
            WHEN NOT MATCHED AND source._deleted = false THEN INSERT *
            """
        )
    else:
        spark_session.sql(
            f"""
            MERGE INTO {table_name} AS target
            USING __asmdb_changes AS source
            ON target.id = source.id
            WHEN MATCHED THEN UPDATE SET *
            WHEN NOT MATCHED THEN INSERT *
            """
        )

    write_watermark_property(spark_session, table_name, watermark)


def _iso_to_datetime(value: Any) -> Optional[datetime]:
    """Parse the ISO strings produced by _millis_to_iso back into datetimes.

    Spark needs real datetime objects to fill a TimestampType column; handing it
    the ISO string silently produces a string column instead, which then fails
    the MERGE against an existing table.
    """

    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    text = str(value)
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


FIXED_COLUMN_TYPES: Tuple[Tuple[str, str, bool], ...] = (
    ("id", "long", False),
    ("value", "long", True),
    ("tag", "string", True),
    ("content_raw", "string", True),
    ("created", "timestamp", True),
    ("updated", "timestamp", True),
    ("_commit_seq", "long", True),
    ("_deleted", "boolean", True),
    ("_decode_error", "string", True),
    ("_synced_at", "timestamp", True),
)


def _extra_column_type(rows: Sequence[Mapping[str, Any]], name: str) -> str:
    """Pick a type for a decoder-added column from its first non-null value."""

    for row in rows:
        value = row.get(name)
        if value is None:
            continue
        if isinstance(value, bool):
            return "boolean"
        if isinstance(value, int):
            return "long"
        if isinstance(value, float):
            return "double"
        return "string"
    return "string"


def changes_schema(rows: Sequence[Mapping[str, Any]]) -> Any:
    """Build an explicit schema for the staged change rows.

    Schema inference cannot be used here. A batch whose optional columns are
    null in every row - which is the normal case for a table that never sets
    `value` or `tag`, and always the case for `_synced_at` - makes Spark raise
    CANNOT_DETERMINE_TYPE and fails the whole sync.
    """

    from pyspark.sql.types import (
        BooleanType,
        DoubleType,
        LongType,
        StringType,
        StructField,
        StructType,
        TimestampType,
    )

    mapping = {
        "long": LongType(),
        "string": StringType(),
        "boolean": BooleanType(),
        "double": DoubleType(),
        "timestamp": TimestampType(),
    }

    fields = [StructField(name, mapping[kind], nullable) for name, kind, nullable in FIXED_COLUMN_TYPES]
    known = {name for name, _, _ in FIXED_COLUMN_TYPES}

    extras: List[str] = []
    for row in rows:
        for name in row:
            if name not in known and name not in extras:
                extras.append(name)
    for name in extras:
        fields.append(StructField(name, mapping[_extra_column_type(rows, name)], True))

    return StructType(fields)


def changes_dataframe(spark_session: Any, rows: Sequence[Mapping[str, Any]]) -> Any:
    """Stage change rows with an explicit schema rather than by inference."""

    schema = changes_schema(rows)
    names = [field.name for field in schema.fields]
    timestamps = {"created", "updated", "_synced_at"}
    prepared = [
        tuple(_iso_to_datetime(row.get(name)) if name in timestamps else row.get(name) for name in names)
        for row in rows
    ]
    return spark_session.createDataFrame(prepared, schema)


def apply_rebuild_rows(spark_session: Any, table_name: str, rows: Sequence[Mapping[str, Any]], watermark: int) -> None:
    """Replace the table from a complete CDC replay, then advance watermark."""

    plan = rebuild_write_plan()
    if plan != ("replace_data", "write_watermark"):
        raise AssertionError("rebuild must replace data before writing watermark")

    from pyspark.sql import functions as F

    if rows:
        replacement = changes_dataframe(spark_session, rows)
    elif table_exists(spark_session, table_name):
        replacement = spark_session.table(table_name).limit(0)
    else:
        replacement = spark_session.createDataFrame([], changes_schema([]))

    replacement = replacement.withColumn("_synced_at", F.current_timestamp())
    replacement.writeTo(table_name).using("delta").createOrReplace()
    write_watermark_property(spark_session, table_name, watermark)


def _base_seq_from_reseed(reason: ReseedRequired) -> int:
    try:
        return int(reason.detail.get("baseSeq", 0))
    except (TypeError, ValueError):
        return 0


def _requested_seq_from_reseed(reason: ReseedRequired, fallback: int) -> int:
    for key in ("requestedFrom", "failedAt"):
        value = reason.detail.get(key)
        if value not in (None, ""):
            try:
                return int(value)
            except (TypeError, ValueError):
                pass
    return fallback


def _unavailable_rebuild(reason: ReseedRequired, requested_seq: int) -> FullReloadUnavailable:
    base_seq = _base_seq_from_reseed(reason)
    return FullReloadUnavailable(
        f"automatic rebuild cannot produce a complete table after {reason.reason}: "
        f"CDC baseSeq={base_seq}, requested sequence={requested_seq}. "
        "The log no longer reaches back far enough; increase retention or provide a snapshot source."
    )


def rebuild_from_cdc_base(
    spark_session: Any,
    gateway_url: str,
    instance_id: str,
    token: str,
    table_name: str,
    reason: ReseedRequired,
    requested_seq: int,
) -> int:
    base_seq = _base_seq_from_reseed(reason)
    if base_seq > 0:
        raise _unavailable_rebuild(reason, requested_seq)

    print(f"WARNING: incremental CDC stopped because {reason.reason}; rebuilding table from CDC baseSeq={base_seq}")
    from_seq = base_seq
    frames_for_rebuild: List[Dict[str, Any]] = []
    while True:
        try:
            frames, headers = fetch_cdc_page(gateway_url, instance_id, token, from_seq, PAGE_LIMIT)
        except ReseedRequired as replay_error:
            raise _unavailable_rebuild(replay_error, requested_seq) from replay_error

        header_base_seq = _header_int(headers, "X-Asmdb-Base-Seq", base_seq)
        if header_base_seq > 0:
            raise FullReloadUnavailable(
                f"automatic rebuild cannot produce a complete table after {reason.reason}: "
                f"CDC baseSeq={header_base_seq}, requested sequence={requested_seq}. "
                "The log no longer reaches back far enough; increase retention or provide a snapshot source."
            )
        if not frames:
            break
        frames_for_rebuild.extend(frames)
        last_in_page = max(int(f["commitSeq"]) for f in frames)
        has_more = str(headers.get("X-Asmdb-Has-More", "false")).lower() == "true"
        if not has_more:
            break
        from_seq = last_in_page + 1

    rows, new_watermark = fold_rebuild_frames(frames_for_rebuild, base_seq=base_seq, decoder=DECODER, config=DECODER_CONFIG)
    apply_rebuild_rows(spark_session, table_name, rows, new_watermark)
    print(f"WARNING: automatic rebuild completed after {reason.reason}; watermark={new_watermark}")
    return new_watermark


def run_sync() -> None:
    token = get_gateway_token(KEY_VAULT_URL, KEY_VAULT_SECRET_NAME)
    last_seq = read_watermark(spark, TARGET_TABLE)  # noqa: F821 - provided by Fabric
    from_seq = last_seq + 1
    all_frames: List[Dict[str, Any]] = []

    while True:
        try:
            frames, headers = fetch_cdc_page(GATEWAY_URL, INSTANCE_ID, token, from_seq, PAGE_LIMIT)
            require_incremental_frames(frames)
        except ReseedRequired as reseed:
            if reseed.reason in ("cdc_gap", "cdc_corrupt"):
                requested_seq = _requested_seq_from_reseed(reseed, from_seq)
                new_watermark = rebuild_from_cdc_base(spark, GATEWAY_URL, INSTANCE_ID, token, TARGET_TABLE, reseed, requested_seq)  # noqa: F821
                acknowledge_watermark(GATEWAY_URL, INSTANCE_ID, token, new_watermark)
                return
            raise
            return

        if not frames:
            break
        all_frames.extend(frames)
        last_in_page = max(int(f["commitSeq"]) for f in frames)
        has_more = str(headers.get("X-Asmdb-Has-More", "false")).lower() == "true"
        if not has_more:
            break
        from_seq = last_in_page + 1

    rows, new_watermark = collapse_frames(all_frames, decoder=DECODER, config=DECODER_CONFIG)
    if new_watermark <= last_seq:
        return
    apply_incremental_rows(spark, TARGET_TABLE, rows, new_watermark, hard_delete=HARD_DELETE)  # noqa: F821
    acknowledge_watermark(GATEWAY_URL, INSTANCE_ID, token, new_watermark)


# %%
# Uncomment in Fabric after rendering parameters:
# run_sync()
