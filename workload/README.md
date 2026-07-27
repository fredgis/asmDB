# `workload/` — asmDB Analytical Capabilities

A custom [Microsoft Fabric](https://learn.microsoft.com/fabric/) workload that
synchronises asmDB databases into Fabric lakehouses using the change log the engine
already writes, and shows the resulting links, lag and coverage.

**Nothing here is built yet.** This directory currently holds the design target and
the future home of the implementation. The architecture and the development plan are
in **[`docs/WORKLOAD.md`](../docs/WORKLOAD.md)** — read that first.

## What is here

| Path | Contents |
|---|---|
| `mockup/index.html` | The design target. Open it directly in a browser; there is no build step and no server. |
| `mockup/mockup.css` | Its styles. Brand tokens are copied from `site/css/tokens.css`, which remains the source of truth. |

## What will be here

Per the plan, and created only when its phase begins:

| Path | Workstream |
|---|---|
| `frontend/` | C — React + Fluent UI v9 surface, running in a Fabric iframe |
| `backend/` | D — token broker; Fabric JWT in, scoped asmDB credentials out |
| `notebooks/` | E — the PySpark template that reads change frames and merges into Delta |
| `manifest/` | F — `WorkloadManifest.xml`, `Product.json`, item manifests |
| `build/` | F — `.nuspec`, packaging and deployment scripts |
| `docs/` | G — runbook and operational notes |

## The one thing to understand before reading the plan

**Fabric Spark writes the Delta tables; we do not.** The workload generates a notebook
in the customer's workspace and lets Fabric schedule and run it. No customer row passes
through anything we operate, the customer's own capacity pays for the compute, and the
sync is a notebook they can read rather than a connector they must trust.

The reasoning, and what it costs us, is in
[`docs/WORKLOAD.md` §1](../docs/WORKLOAD.md).
