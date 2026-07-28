from __future__ import annotations

import base64
import json
import sys
import types

import pytest

import sync_template
from sync_template import (
    FIXED_COLUMN_TYPES,
    row_from_op,
    FullReloadUnavailable,
    _extra_column_type,
    _iso_to_datetime,
    _millis_to_iso,
    ReseedRequired,
    TransientGatewayError,
    acknowledge_watermark,
    classify_gateway_response,
    collapse_frames,
    decode_content,
    fetch_cdc_page,
    fold_rebuild_frames,
    get_gateway_token,
    incremental_write_plan,
    parse_ndjson,
    rebuild_from_cdc_base,
    rebuild_write_plan,
)


def frame(seq, ops, reset=False):
    return {"commitSeq": str(seq), "flags": {"reset": reset}, "ops": ops}


def upsert(row_id, value, content="plain"):
    return {
        "op": "upsert",
        "id": str(row_id),
        "record": {
            "id": str(row_id),
            "value": str(value),
            "tag": "orders",
            "content": content,
            "created": "1785079512121",
            "updated": "1785079512999",
        },
    }


def delete(row_id):
    return {"op": "delete", "id": str(row_id)}


def test_parse_ndjson_ignores_torn_last_line():
    text = json.dumps(frame(1, [upsert(1, 10)])) + "\n" + '{"commitSeq":"2",'
    parsed = parse_ndjson(text)
    assert parsed.ignored_torn_last_line is True
    assert [f["commitSeq"] for f in parsed.frames] == ["1"]


def test_parse_ndjson_rejects_complete_bad_line():
    with pytest.raises(json.JSONDecodeError):
        parse_ndjson('{"commitSeq":"1",}\n')


def test_collapse_three_updates_last_value_wins():
    rows, watermark = collapse_frames([frame(1, [upsert(7, 1), upsert(7, 2), upsert(7, 3)])])
    assert watermark == 1
    assert len(rows) == 1
    assert rows[0]["id"] == 7
    assert rows[0]["value"] == 3


def test_collapse_delete_then_upsert_same_id_upsert_wins():
    rows, _ = collapse_frames([frame(1, [delete(7), upsert(7, 99)])])
    assert len(rows) == 1
    assert rows[0]["id"] == 7
    assert rows[0]["_deleted"] is False
    assert rows[0]["value"] == 99


def test_cdc_gap_triggers_reseed():
    body = '{"error":{"code":"cdc_gap","baseSeq":"5000","requestedFrom":"120"}}'
    with pytest.raises(ReseedRequired) as exc:
        classify_gateway_response(409, body)
    assert exc.value.reason == "cdc_gap"
    assert exc.value.detail["baseSeq"] == "5000"


def test_cdc_corrupt_triggers_reseed_with_distinct_reason():
    body = '{"error":{"code":"cdc_corrupt","message":"crc failed","baseSeq":"5000","lastSeq":"9100","failedAt":"7421"}}'
    with pytest.raises(ReseedRequired) as exc:
        classify_gateway_response(409, body)
    assert exc.value.reason == "cdc_corrupt"
    assert exc.value.detail["failedAt"] == "7421"


def test_503_is_transient_gateway_error():
    with pytest.raises(TransientGatewayError):
        classify_gateway_response(503, '{"error":{"code":"share_unreadable"}}')


def test_reset_frame_triggers_reseed():
    with pytest.raises(ReseedRequired) as exc:
        collapse_frames([frame(42, [], reset=True)])
    assert exc.value.reason == "reset_frame"
    assert exc.value.detail["commitSeq"] == "42"


def test_rebuild_fold_from_base_reconstructs_current_image():
    rows, watermark = fold_rebuild_frames(
        [
            frame(1, [], reset=True),
            frame(2, [upsert(1, 10), upsert(2, 20)]),
            frame(3, [upsert(1, 11), delete(2), upsert(3, 30)]),
            frame(4, [delete(99)]),
        ],
        base_seq=0,
    )

    by_id = {row["id"]: row for row in rows}
    assert watermark == 4
    assert set(by_id) == {1, 3}
    assert by_id[1]["value"] == 11
    assert by_id[3]["value"] == 30


def test_rebuild_fold_allows_reset_frame_at_base():
    rows, watermark = fold_rebuild_frames([frame(1, [], reset=True), frame(2, [upsert(7, 70)])], base_seq=0)
    assert watermark == 2
    assert rows[0]["id"] == 7


def test_rebuild_fold_rejects_trimmed_base():
    with pytest.raises(FullReloadUnavailable) as exc:
        fold_rebuild_frames([frame(6, [upsert(7, 70)])], base_seq=5)

    assert "baseSeq=5" in str(exc.value)
    assert "early frames have been trimmed" in str(exc.value)


@pytest.mark.parametrize(
    "decoder,raw,expected",
    [
        ("None", "abc", {"content_raw": "abc"}),
        ("Hex", "68656c6c6f", {"content_decoded": "hello"}),
        ("Base64", base64.b64encode(b"hello").decode(), {"content_decoded": "hello"}),
        ("JSON", '{"a":1,"b":"two"}', {"content_a": 1, "content_b": "two"}),
        ("CSV", 'alpha,"beta,gamma"', {"content_first": "alpha", "content_second": "beta,gamma"}),
        ("MessagePack", base64.b64encode(b"\x81\xa1a\x01").decode(), {"content_a": 1}),
    ],
)

def test_decoders_success(decoder, raw, expected):
    config = {"columns": ["first", "second"]} if decoder == "CSV" else None
    decoded = decode_content(raw, decoder, config)
    assert decoded["_decode_error"] is None
    for key, value in expected.items():
        assert decoded[key] == value


@pytest.mark.parametrize(
    "decoder,raw",
    [
        ("Hex", "not hex"),
        ("Base64", "not base64"),
        ("JSON", "{"),
        ("CSV", '"unterminated'),
        ("MessagePack", base64.b64encode(b"\xc1").decode()),
    ],
)

def test_decoders_malformed_mark_error_without_dropping(decoder, raw):
    decoded = decode_content(raw, decoder)
    assert decoded["content_raw"] == raw
    assert decoded["_decode_error"]


def test_repeated_batch_collapse_is_idempotent():
    batch = [frame(1, [upsert(1, 10), upsert(2, 20)]), frame(2, [upsert(1, 11)])]
    once_rows, once_watermark = collapse_frames(batch)
    twice_rows, twice_watermark = collapse_frames(batch + batch)
    assert sorted(once_rows, key=lambda r: r["id"]) == sorted(twice_rows, key=lambda r: r["id"])
    assert once_watermark == twice_watermark == 2


def test_incremental_write_plan_writes_data_before_watermark():
    plan = incremental_write_plan(has_data_changes=True)
    assert plan == ("merge_data", "write_watermark")
    assert plan.index("merge_data") < plan.index("write_watermark")


def test_rebuild_write_plan_writes_data_before_watermark():
    plan = rebuild_write_plan()
    assert plan == ("replace_data", "write_watermark")
    assert plan.index("replace_data") < plan.index("write_watermark")


def test_gap_with_reachable_base_rebuilds(monkeypatch):
    applied = {}

    def fake_fetch(gateway, instance, token, from_seq, limit):
        assert from_seq == 0
        return (
            [frame(1, [], reset=True), frame(2, [upsert(1, 10), upsert(2, 20)]), frame(3, [delete(2)])],
            {"X-Asmdb-Base-Seq": "0", "X-Asmdb-Has-More": "false"},
        )

    def fake_apply(spark, table, rows, watermark):
        applied["spark"] = spark
        applied["table"] = table
        applied["rows"] = rows
        applied["watermark"] = watermark

    monkeypatch.setattr("sync_template.fetch_cdc_page", fake_fetch)
    monkeypatch.setattr("sync_template.apply_rebuild_rows", fake_apply)

    reason = ReseedRequired("cdc_gap", {"baseSeq": "0", "requestedFrom": "120"})
    watermark = rebuild_from_cdc_base("spark", "gateway", "instance", "token", "target", reason, requested_seq=120)

    assert watermark == 3
    assert applied["table"] == "target"
    assert applied["watermark"] == 3
    assert [row["id"] for row in applied["rows"]] == [1]


def test_gap_with_unreachable_base_raises_with_sequence_numbers():
    reason = ReseedRequired("cdc_gap", {"baseSeq": "5000", "requestedFrom": "120"})

    with pytest.raises(FullReloadUnavailable) as exc:
        rebuild_from_cdc_base("spark", "gateway", "instance", "token", "target", reason, requested_seq=120)

    message = str(exc.value)
    assert "baseSeq=5000" in message
    assert "requested sequence=120" in message


def test_acknowledge_failure_logs_and_does_not_fail(monkeypatch, capsys):
    class Response:
        status_code = 503
        text = "temporarily unavailable"

    fake_requests = types.SimpleNamespace(post=lambda *args, **kwargs: Response())
    monkeypatch.setitem(sys.modules, "requests", fake_requests)

    assert acknowledge_watermark("https://gateway.example", "instance", "secret", 42) is False
    assert "WARNING: watermark 42 was committed locally" in capsys.readouterr().out


def test_get_gateway_token_uses_notebookutils(monkeypatch):
    fake_credentials = types.SimpleNamespace(getSecret=lambda vault, name: f"{vault}|{name}")
    fake_notebookutils = types.SimpleNamespace(credentials=fake_credentials)
    monkeypatch.setattr("sync_template.notebookutils", fake_notebookutils, raising=False)

    assert get_gateway_token("https://vault.vault.azure.net/", "asmdb-token") == (
        "https://vault.vault.azure.net/|asmdb-token"
    )


def test_get_gateway_token_outside_fabric_has_clear_error(monkeypatch):
    monkeypatch.delattr("sync_template.notebookutils", raising=False)

    with pytest.raises(Exception) as exc:
        get_gateway_token("https://vault.vault.azure.net/", "asmdb-token")

    assert "notebookutils is unavailable" in str(exc.value)
    assert "Microsoft Fabric Spark session" in str(exc.value)


def test_fetch_cdc_page_retries_503_with_backoff(monkeypatch):
    calls = []

    class Response:
        def __init__(self, status_code, text, headers=None):
            self.status_code = status_code
            self.text = text
            self.headers = headers or {}

    responses = [
        Response(503, "share unavailable"),
        Response(200, json.dumps(frame(1, [upsert(1, 10)])) + "\n", {"X-Asmdb-Has-More": "false"}),
    ]

    def fake_get(*args, **kwargs):
        calls.append((args, kwargs))
        return responses.pop(0)

    fake_requests = types.SimpleNamespace(get=fake_get)
    monkeypatch.setitem(sys.modules, "requests", fake_requests)
    monkeypatch.setattr("sync_template.time.sleep", lambda seconds: None)

    frames, headers = fetch_cdc_page(
        "https://gateway.example",
        "instance",
        "secret",
        1,
        5000,
        max_attempts=2,
        initial_backoff_seconds=0,
    )
    assert len(calls) == 2
    assert frames[0]["commitSeq"] == "1"
    assert headers["X-Asmdb-Has-More"] == "false"


def test_extra_column_type_falls_back_to_string_when_every_value_is_null():
    rows = [{"content_note": None}, {"content_note": None}]
    assert _extra_column_type(rows, "content_note") == "string"


def test_extra_column_type_reads_the_first_non_null_value():
    rows = [{"n": None}, {"n": 7}, {"n": "later"}]
    assert _extra_column_type(rows, "n") == "long"
    assert _extra_column_type([{"b": True}], "b") == "boolean"
    assert _extra_column_type([{"f": 1.5}], "f") == "double"


def test_every_fixed_column_has_a_declared_type():
    """Schema inference fails when an optional column is null in every row.

    A batch from a table that never sets `value` or `tag` is ordinary, and
    `_synced_at` is null in every row by construction because it is filled in
    after staging. Relying on inference made Spark raise CANNOT_DETERMINE_TYPE
    and fail the whole sync, so each column must carry its own declared type.
    """

    names = [name for name, _, _ in FIXED_COLUMN_TYPES]
    row = row_from_op({"op": "upsert", "id": "1", "record": {"id": "1", "content": "x"}}, 1)
    assert set(row) <= set(names)
    for name in ("value", "tag", "_synced_at", "_decode_error"):
        assert name in names
        assert row.get(name) is None


def test_iso_to_datetime_accepts_the_form_millis_to_iso_produces():
    iso = _millis_to_iso(1785243600000)
    assert iso.endswith("Z")
    parsed = _iso_to_datetime(iso)
    assert parsed is not None
    assert parsed.year >= 2020
    assert _iso_to_datetime(None) is None
    assert _iso_to_datetime("not a date") is None


def test_paging_uses_the_gateways_exclusive_from_semantics(monkeypatch):
    """The gateway skips frames whose commitSeq is <= from.

    api.go: `if frame.CommitSeq <= from { continue }`, and the gateway README
    tells clients to "keep paging from the last consumed commitSeq". Asking for
    watermark + 1 therefore skips exactly one frame on every call - the first
    unconsumed one - which is silent data loss. It hid a RESET frame in
    production and made a run that changed nothing report success.
    """

    requested = []

    def fake_fetch(gateway, instance, token, from_seq, limit):
        requested.append(from_seq)
        if len(requested) == 1:
            return ([frame(4, [upsert(1, 10)]), frame(5, [upsert(2, 20)])], {"X-Asmdb-Has-More": "true"})
        return ([frame(6, [upsert(3, 30)])], {"X-Asmdb-Has-More": "false"})

    monkeypatch.setattr("sync_template.fetch_cdc_page", fake_fetch)
    monkeypatch.setattr("sync_template.get_gateway_token", lambda vault, name: "token")
    monkeypatch.setattr("sync_template.spark", object(), raising=False)
    monkeypatch.setattr("sync_template.read_watermark", lambda spark, table: 3)
    monkeypatch.setattr("sync_template.apply_incremental_rows", lambda *a, **k: None)
    monkeypatch.setattr("sync_template.acknowledge_watermark", lambda *a, **k: True)

    sync_template.run_sync()

    assert requested == [3, 5], "from must be the last consumed commitSeq, never that plus one"


def test_rebuild_paging_also_uses_exclusive_from(monkeypatch):
    requested = []

    def fake_fetch(gateway, instance, token, from_seq, limit):
        requested.append(from_seq)
        if len(requested) == 1:
            return ([frame(1, [upsert(1, 10)]), frame(2, [upsert(2, 20)])], {"X-Asmdb-Has-More": "true", "X-Asmdb-Base-Seq": "0"})
        return ([frame(3, [upsert(3, 30)])], {"X-Asmdb-Has-More": "false", "X-Asmdb-Base-Seq": "0"})

    monkeypatch.setattr("sync_template.fetch_cdc_page", fake_fetch)
    monkeypatch.setattr("sync_template.apply_rebuild_rows", lambda *a, **k: None)

    reason = ReseedRequired("cdc_gap", {"baseSeq": "0", "requestedFrom": "9"})
    rebuild_from_cdc_base("spark", "gateway", "instance", "token", "target", reason, requested_seq=9)

    assert requested == [0, 2]


def test_a_reset_frame_fails_the_run_rather_than_emptying_the_table(monkeypatch):
    """BENCH, TRUNCATE and RESTORE emit one RESET frame carrying no operations.

    The change log cannot rebuild the table from that: replaying it clears the
    image and leaves nothing behind. Refusing loudly is correct - silently
    writing an empty table would destroy the lakehouse copy.
    """

    def fake_fetch(gateway, instance, token, from_seq, limit):
        return ([frame(7, [], reset=True)], {"X-Asmdb-Has-More": "false"})

    monkeypatch.setattr("sync_template.fetch_cdc_page", fake_fetch)
    monkeypatch.setattr("sync_template.get_gateway_token", lambda vault, name: "token")
    monkeypatch.setattr("sync_template.spark", object(), raising=False)
    monkeypatch.setattr("sync_template.read_watermark", lambda spark, table: 6)

    applied = []
    monkeypatch.setattr("sync_template.apply_incremental_rows", lambda *a, **k: applied.append(a))
    monkeypatch.setattr("sync_template.apply_rebuild_rows", lambda *a, **k: applied.append(a))

    with pytest.raises(FullReloadUnavailable) as exc:
        sync_template.run_sync()

    assert "replaced wholesale" in str(exc.value)
    assert "left exactly as it was" in str(exc.value)
    assert applied == [], "a reset must not write anything"
