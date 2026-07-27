from __future__ import annotations

import base64
import json
import sys
import types

import pytest

from sync_template import (
    ReseedRequired,
    TransientGatewayError,
    acknowledge_watermark,
    classify_gateway_response,
    collapse_frames,
    decode_content,
    fetch_cdc_page,
    get_gateway_token,
    incremental_write_plan,
    parse_ndjson,
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
