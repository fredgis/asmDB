# asmDB Fabric sync notebook template

This directory contains the generated-notebook template for one asmDB sync link:

- `sync_template.py` — PySpark notebook source with clean `# %%` cell boundaries.
- `render.py` — substitutes per-link values into the template.
- `test_sync.py` — plain Python tests for CDC parsing, collapse, decoder, reseed and snapshot-seeding semantics.

## What the notebook does

1. Reads the target Delta table watermark from table property `asmdb.cdc.watermark` (missing means `0`) and fetches from `watermark + 1`.
2. Replicates gateway CDC events on the schedule: collapse each batch to one row per `id`, `MERGE INTO`, then advance the watermark.
3. On `cdc_gap` or `cdc_corrupt`, automatically rebuilds from the retained CDC base when that base is complete.
4. On a `reset` frame, seeds the target from the gateway snapshot and then resumes incremental consumption from the snapshot's sequence. `TRUNCATE`, `RESTORE` and `BENCH` each emit exactly one `RESET` frame carrying no operations, so the change log cannot rebuild the table and the snapshot is the only honest source. Reseeds are capped at `MAX_RESEEDS_PER_RUN` (3) per run; a source replaced faster than that fails loudly with the last seeded image left intact.
5. Collapses a batch to one row per `id`, with the last operation in commit order winning.
6. Keeps `content_raw`, optionally decodes `content`, and marks `_decode_error` without dropping bad rows.
7. Applies tombstones by default (`_deleted=true`); hard delete is a render option.
8. Writes data first, then advances `asmdb.cdc.watermark`, then acknowledges the watermark.

The Spark shell is deliberately thin. Pure functions in `sync_template.py` cover NDJSON parsing, gateway error classification, reset detection, row collapse and content decoding, so they can be tested without Fabric or Spark.

## Crash and replay guarantee

Sync always writes data before it writes the watermark. The watermark must never be advanced before the data it describes: if Spark crashed in that order, the next run would skip missing rows. With the implemented order, a crash after `MERGE INTO` but before `ALTER TABLE ... SET TBLPROPERTIES` leaves the old watermark in place, so the next run replays the same batch. That replay is harmless because the merge is idempotent on `id` with full row images.

Automatic rebuild follows the same ordering: replace the table first, then write the watermark. A crash before the watermark leaves the next run to repeat the rebuild rather than skip data.

Gateway acknowledgement happens after the local data and watermark are committed. If acknowledgement fails, the notebook logs a warning and still succeeds; asmDB keeps frames longer, but the lakehouse is already correct.

`cdc_gap` and `cdc_corrupt` both stop ordinary incremental consumption, but the notebook preserves the distinct reason for operators: a gap is usually retention tuning, while corruption means a damaged change frame. HTTP 503 from the CDC endpoint is treated as transient share unreadability and retried with exponential backoff.

## Automatic rebuild

There is no user-facing sync mode. The notebook normally replicates change events incrementally. If the gateway reports `cdc_gap` or `cdc_corrupt`, the notebook attempts automatic recovery by replaying from the CDC base. If the gateway reports `X-Asmdb-Base-Seq: 0`, it can replay every frame from the base: `upsert` sets the live record for an id, `delete` removes it, and `reset` clears the in-memory image before later frames are applied. The resulting complete image is written with `createOrReplace`, then the watermark is advanced to the last sequence seen.

This works **only while retention covers the whole history**. If the retained base is greater than zero, the early frames needed to rebuild old live rows are gone. In that case automatic rebuild raises a clear error naming `baseSeq` and the requested sequence; it never silently rebuilds from the retained tail and calls that complete. `cdc_gap` and `cdc_corrupt` do not fall back to the snapshot — only a `reset` frame does.

## Snapshot reseed on RESET

`TRUNCATE`, `RESTORE` and `BENCH` replace the whole table and the engine reports each as a single operation-less `RESET` frame. The change log cannot replay that, so on a `reset` frame the notebook seeds from the gateway snapshot instead.

The seed pages `GET /snapshot/{instanceId}?after=&limit=` and stages each page into a temporary Delta table rather than accumulating every row in driver memory. The snapshot is pinned to `X-Asmdb-Snapshot-Seq`; if the sequence changes between pages the notebook discards the stage and restarts from the first page, up to `max_restarts`. `snapshot_unstable` (HTTP 503) leaves the existing lakehouse table untouched and fails the run. When all pages are staged, the notebook replaces the target from the stage, writes the watermark to the snapshot sequence, then resumes incremental consumption from that sequence — so the seeded rows and the resume point share one sequence and no frame is skipped or double-applied. Reseeds are capped at `MAX_RESEEDS_PER_RUN` per run.

## Key Vault credential path

The rendered notebook contains no gateway secret. Fabric notebooks do not support `DefaultAzureCredential` directly, so the notebook uses Fabric's built-in `notebookutils` namespace:

```python
notebookutils.credentials.getSecret(KEY_VAULT_URL, KEY_VAULT_SECRET_NAME)
```

No `azure-identity` or `azure-keyvault-secrets` package is required or useful for this path.

## Scheduled identity requirement

`notebookutils.credentials.getSecret` authenticates as the identity that is running the notebook. That identity depends on how the notebook is triggered:

| Trigger | Runs as | Usable unattended? |
|---|---|---|
| Interactive run | The person clicking | No |
| Direct Fabric schedule | The user who created or last updated the schedule | No |
| Pipeline activity (default) | The pipeline's last-modified user | No |
| Pipeline activity with Workspace Identity | The workspace service principal | Yes |

Only **pipeline activity with Workspace Identity** is supported for scheduled syncs. Direct notebook schedules run as a named human account; they can pass tests and then fail later when that person's access changes. For production, grant the workspace service principal **Key Vault Secrets User** on the vault or the narrower secret scope.

## Rendering

```powershell
python workload\notebooks\render.py `
  --gateway-url https://gateway.example.com `
  --instance-id orders-prod `
  --target-table lakehouse.sales_orders_db `
  --key-vault-url https://my-vault.vault.azure.net/ `
  --secret-name asmdb-orders-gateway-token `
  --decoder JSON `
  --output workload\notebooks\orders_sync.py
```

`--decoder` may be `None`, `Hex`, `Base64`, `JSON`, `CSV`, or `MessagePack`. CSV column names can be supplied with `--decoder-config-json '{"columns":["a","b"]}'`. Changing decoder is a reseed operation because already-written rows were interpreted under the old decoder.

## Running by hand in Fabric

1. Render the notebook for the sync link.
2. Upload/convert it to a Fabric notebook attached to the target lakehouse.
3. For scheduled syncs, invoke it from a Fabric pipeline activity configured to use Workspace Identity.
4. Ensure the workspace service principal has **Key Vault Secrets User** on the vault or secret.
5. Uncomment `run_sync()` in the last cell, or call `run_sync()` manually.

## What could not be verified locally

This repository environment has no Spark/Fabric runtime, no Delta table and no live Key Vault. The pure CDC semantics are tested locally; `notebookutils` Key Vault access, Fabric Delta `MERGE INTO` execution, and the gateway acknowledge endpoint must be verified in an actual Fabric workspace with the gateway deployed.
