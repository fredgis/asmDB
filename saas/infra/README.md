# asmdb Cloud Azure infrastructure

This folder contains the idempotent Azure deployment for asmdb Cloud in the existing `<service-resource-group>` resource group in `swedencentral`.

## Resources created

- Log Analytics workspace `asmdb-logs` (`PerGB2018`, 30-day retention)
- Azure Container Registry `asmdbacr<stable-suffix>` (Basic, admin disabled)
- User-assigned managed identity `asmdb-mi`
- Container Apps managed environment `asmdb-env`
- Storage account `asmdbst<stable-suffix>` with private blob container `instances`
- Control-plane Container App `asmdb-cp`
- Resource-group-scoped role assignments for `asmdb-mi`: AcrPull, Contributor, Storage Blob Data Contributor

The suffix is derived from `uniqueString(resourceGroup().id)`, so repeated deployments converge on the same names.

## Deploy

```powershell
.\deploy.ps1 -Tag latest
```

Options:

- `-Tag <tag>` builds and deploys both `asmdb-instance:<tag>` and `asmdb-controlplane:<tag>`.
- `-SkipBuild` redeploys infrastructure and updates the Container App without rebuilding images.
- `-WhatIf` runs Azure what-if only and stops.

The script requires Azure CLI login to tenant `<tenant-id>` and subscription `<subscription-id>`.

## Cost notes

Approximate cost drivers are Log Analytics ingestion/retention, ACR Basic, the Container Apps environment/control-plane replica, storage capacity/transactions, and any `db-*` Container Apps created by the control plane. The control plane is pinned to one 0.5 CPU / 1 Gi replica.

## Tear down

```powershell
.\teardown.ps1
```

Use `-Force` to skip the prompt. The teardown deletes the platform resources and every `db-*` Container App, but never deletes the `<service-resource-group>` resource group.
