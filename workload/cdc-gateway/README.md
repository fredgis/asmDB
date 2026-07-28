# asmDB CDC gateway

The CDC gateway is a small workload-only HTTP service that reads asmDB `.cdc`
files from a mounted instance share and serves complete change frames as NDJSON.
It does not modify the engine or sidecar, does not expose a public data-plane API,
and must never write to the mounted share.

## Mount contract

`ASMDB_SHARE_ROOT` must point at the mounted share root. Each asmDB instance is a
subdirectory containing exactly one `.cdc` file and, for `/head`, the matching
`.dat` file.

The share must be mounted read-only at the OS/filesystem level. The expected
Azure Files NFS mount option set is the platform's normal asmDB share options
plus `ro`; for example, the gateway-relevant part is:

```text
-o vers=4.1,sec=sys,ro
```

Other performance or network options may be added by the deployment, but `ro`
is mandatory.

- Linux: mount with the read-only flag, for example `ro` in the NFS mount
  options.
- Windows: mount as a volume/share that reports `FILE_READ_ONLY_VOLUME` through
  `GetVolumeInformationW`.

At startup the gateway asks the OS whether `ASMDB_SHARE_ROOT` is read-only. If
the OS reports writable, or if the read-only state cannot be inspected, startup
fails. This makes the no-write guarantee structural rather than a coding
convention. The check has been verified locally; it still needs first-deployment
confirmation against the real Azure Files read-only mount.

## Configuration

- `ASMDB_SHARE_ROOT` — required mounted share root.
- `ASMDB_GATEWAY_TOKEN` — required bearer token.
- `PORT` — optional, defaults to `8080`.

## API

- `GET /healthz` is unauthenticated and only checks whether the share root can be
  statted.
- `GET /cdc/{instanceId}/head` returns `baseSeq`, `lastSeq`, and `rows`.
- `GET /cdc/{instanceId}?from=<seq>&limit=<n>` returns one JSON object per
  complete CDC frame, with `X-Asmdb-Base-Seq`, `X-Asmdb-Last-Seq`, and
  `X-Asmdb-Has-More` headers.
- `GET /snapshot/{instanceId}?after=<slot>&limit=<n>` returns one upsert-shaped
  JSON object per live row from the current `.dat` image, pinned to
  `X-Asmdb-Snapshot-Seq`. Paging is by slot index using `X-Asmdb-Next-After`;
  each page also reports the source header's `X-Asmdb-Live-Rows`.

`limit` defaults to 100 and is capped at 1000 frames or snapshot rows. Snapshot
pages also scan at most 8192 slots (2 MiB of records) per request, so sparse
reservations can legitimately return zero NDJSON rows with
`X-Asmdb-Has-More: true`; clients should continue from `X-Asmdb-Next-After`.
The caps bound memory, latency, and notebook retry cost while still allowing
efficient watermark paging; clients should keep paging CDC from the last
consumed `commitSeq` and snapshot pages from `X-Asmdb-Next-After`.

## Error vocabulary and consumer response

| Status | Code | Meaning | Consumer response |
|---:|---|---|---|
| 400 | `invalid_request` | Bad `from`, `limit`, or instance id syntax. | Fix the caller bug; do not retry unchanged. |
| 401 | `unauthorized` | Missing or invalid bearer token. | Refresh/reconfigure credentials. |
| 404 | `not_found` | Instance directory or `.cdc` file is absent. | Treat the link as misconfigured or deleted. |
| 409 | `cdc_gap` | `from` is below the log `baseSeq`; history was trimmed. | Stop incremental consumption, reseed from current table state, then resume after the new watermark. |
| 409 | `cdc_corrupt` | A complete frame failed validation. The response includes `baseSeq`, `lastSeq`, and `commitSeq` of the damaged frame when known. | Stop incremental consumption, alert an operator, reseed from current table state, then resume from the known-good `lastSeq`. |
| 409 | `snapshot_moved` | The table's `HDR_SEQ` changed while a snapshot page was being read. | Retry the snapshot page; do not use the torn response. |
| 503 | `snapshot_unstable` | A TRUNCATE, RESTORE, BENCH, or RESET is in flight. | Retry later; the table image is intentionally transient. |
| 503 | `share_unreadable` | The share, `.cdc`, or `.dat` cannot be read right now. | Retry later; this is reserved for transient mount/permission/I/O failures. |

Torn tails are not errors. If an append is in flight or a crash left an
incomplete trailing frame, the gateway serves frames only up to the last complete,
CRC-valid frame and the next page can pick up later.
