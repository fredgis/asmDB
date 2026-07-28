# `workload/` — asmDB Analytical Capabilities

A custom [Microsoft Fabric](https://learn.microsoft.com/fabric/) workload that
synchronises asmDB databases into Fabric lakehouses using the change log the engine
already writes, and shows the resulting links, lag and coverage.

The workload is built and deployed. The architecture and the reasoning behind it
are in **[`docs/WORKLOAD.md`](../docs/WORKLOAD.md)**; the install and release
runbook is in **[`docs/INSTALL.md`](docs/INSTALL.md)**.

## What is here

| Path | Contents |
|---|---|
| `cdc-gateway/` | Go HTTP service. Reads `<db>.cdc` (and `<db>.dat` for `/head` and `/snapshot`) from a read-only mount and serves change frames and snapshots as NDJSON. Deliberately **not** part of the asmdb.cloud public API. |
| `frontend/` | React + Fluent UI v9 surface, running in a Fabric iframe. |
| `backend/` | Node token broker: Fabric JWT in, scoped asmDB credentials out. Also fronts the private gateway for Fabric Spark through `/api/sync/*`. |
| `notebooks/` | The PySpark template that reads change frames, seeds from the snapshot on `RESET`, and merges into Delta. |
| `manifest/` | `WorkloadManifest.xml`, `Product.json`, item manifests. |
| `build/` | `.nuspec`, packaging and deployment scripts. |
| `docs/` | Install runbook and operational notes. |
| `mockup/index.html` | The original design target. Open it directly in a browser; it is self-contained, with no build step and no server. |
| `mockup/assets/asmdb-logo.png` | The asmdb mark, copied from `site/assets/logo.png`. |

## The one thing to understand

**Fabric Spark writes the Delta tables; we do not — and we do not touch the SaaS core.** The workload generates a notebook
in the customer's workspace and lets Fabric schedule and run it. No customer row passes
through anything we operate, the customer's own capacity pays for the compute, and the
sync is a notebook they can read rather than a connector they must trust.

The reasoning, and what it costs us, is in
[`docs/WORKLOAD.md` §1](../docs/WORKLOAD.md).

