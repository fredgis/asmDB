# asmDB Fabric sync notebook template

This directory contains the generated-notebook template for one asmDB sync link:

- `sync_template.py` — PySpark notebook source with clean `# %%` cell boundaries.
- `render.py` — substitutes per-link values into the template.
- `test_sync.py` — plain Python tests for CDC parsing, collapse, decoder and reseed semantics.

## What the notebook does

1. Reads the target Delta table watermark from table property `asmdb.cdc.watermark` (missing means `0`).
2. Fetches NDJSON CDC frames from `{gateway}/cdc/{instanceId}?from=<watermark+1>&limit=<n>`.
3. Stops for full reseed on `cdc_gap`, `cdc_corrupt`, or a frame with `flags.reset=true`.
4. Collapses a batch to one row per `id`, with the last operation in commit order winning.
5. Keeps `content_raw`, optionally decodes `content`, and marks `_decode_error` without dropping bad rows.
6. Applies tombstones by default (`_deleted=true`); hard delete is a render option.
7. Runs an incremental `MERGE INTO`, then advances `asmdb.cdc.watermark`, then acknowledges the watermark.

The Spark shell is deliberately thin. Pure functions in `sync_template.py` cover NDJSON parsing, gateway error classification, reset detection, row collapse and content decoding, so they can be tested without Fabric or Spark.

## Crash and replay guarantee

Incremental sync always writes data before it writes the watermark. The watermark must never be advanced before the data it describes: if Spark crashed in that order, the next run would skip missing rows. With the implemented order, a crash after `MERGE INTO` but before `ALTER TABLE ... SET TBLPROPERTIES` leaves the old watermark in place, so the next run replays the same batch. That replay is harmless because the merge is idempotent on `id` with full row images.

Gateway acknowledgement happens after the local data and watermark are committed. If acknowledgement fails, the notebook logs a warning and still succeeds; asmDB keeps frames longer, but the lakehouse is already correct.

`cdc_gap` and `cdc_corrupt` both stop incremental consumption and require a full reseed, but the notebook preserves the distinct reason for operators: a gap is usually retention tuning, while corruption means a damaged change frame. HTTP 503 from the CDC endpoint is treated as transient share unreadability and retried with exponential backoff.

## Key Vault credential path

The rendered notebook contains no gateway secret. It uses `azure-identity` and `azure-keyvault-secrets` with the Fabric workspace managed identity:

```python
DefaultAzureCredential(exclude_interactive_browser_credential=True)
SecretClient(vault_url=KEY_VAULT_URL, credential=credential).get_secret(KEY_VAULT_SECRET_NAME)
```

Operator grant required: assign the Fabric workspace managed identity the Azure RBAC role **Key Vault Secrets User** on the vault (or narrower scope containing the secret). The Fabric environment must include `azure-identity`, `azure-keyvault-secrets` and `requests`.

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
3. Ensure the workspace managed identity has **Key Vault Secrets User** on the vault.
4. Ensure the Fabric environment has the Python packages above.
5. Uncomment `run_sync()` in the last cell, or call `run_sync()` manually.

## What could not be verified locally

This repository environment has no Spark/Fabric runtime, no Delta table and no live Key Vault. The pure CDC semantics are tested locally; managed-identity authentication, Fabric Delta `MERGE INTO` execution, and the gateway acknowledge endpoint must be verified in an actual Fabric workspace with the gateway deployed.
