# asmdb Cloud Azure infrastructure

This folder contains the idempotent Azure deployment for asmdb Cloud in the existing `<service-resource-group>` resource group in `swedencentral`.

## Resources created

- Log Analytics workspace `asmdb-logs` (`PerGB2018`, 30-day retention)
- Virtual network `asmdb-vnet` (`10.20.0.0/16`) with `snet-aca`, `snet-apim`, and `snet-pe`
- Azure Container Registry `asmdbacr<stable-suffix>` (Premium, admin disabled, private endpoint for pulls)
- User-assigned managed identity `asmdb-mi`
- Internal Container Apps managed environment `asmdb-env`
- Storage account `asmdbst<stable-suffix>` with public access disabled, a private blob endpoint, and private blob container `instances`
- Premium Azure Files NFS account `asmdbfs<stable-suffix>` with public access disabled, private file endpoint, and NFS share `instances`
- Control-plane Container App `asmdb-cp` with internal ingress only
- Azure API Management `asmdb-apim` (Developer, VNet External) as the public front door
- Resource-group-scoped role assignments for `asmdb-mi`: AcrPull, Contributor, Storage Blob Data Contributor

The suffix is derived from `uniqueString(resourceGroup().id)`, so repeated deployments converge on the same names.

## Private networking notes

APIM is the only intended public HTTP entry point. The Container Apps environment and `asmdb-cp` ingress are private, storage blob and NFS file access are via private endpoints, and ACR runtime pulls resolve through a private endpoint.

Customer database traffic also enters through APIM. Instance endpoints use `https://<apim-gateway>/db/<24-char-instance-suffix>/...`; APIM routes that dynamically to `https://db-<suffix>.<container-apps-environment-domain>/...` and leaves the instance `Authorization` bearer token untouched. No permissive CORS policy is configured for the data-plane route because browser clients must not hold instance tokens.

Two things are intentionally not literally private:

- `asmdb-apim` has a public IP because it is the internet-facing site gateway.
- `asmdbacr<stable-suffix>` keeps `publicNetworkAccess: Enabled` so `az acr build` / ACR Tasks can build images from outside the VNet. A fully private build path requires a dedicated ACR Tasks agent pool inside the VNet.

Important migration caveat: an existing non-VNet Container Apps environment cannot be updated in place to add `vnetConfiguration` / `internal: true`. If `asmdb-env` already exists without VNet integration, delete `asmdb-cp` and any `db-*` apps in that environment, then delete `asmdb-env`, before running the deployment.

## Deploy

```powershell
.\deploy.ps1 -Tag latest
```

Options:

- `-Tag <tag>` builds and deploys both `asmdb-instance:<tag>` and `asmdb-controlplane:<tag>`.
- `-SkipBuild` redeploys infrastructure and updates the Container App without rebuilding images.
- `-SkipApim` deploys the private network, private endpoints, internal Container Apps environment, storage, registry, identity, and control plane, but skips APIM for faster iteration.
- `-WhatIf` runs Azure what-if only and stops.

The script requires Azure CLI login to tenant `<tenant-id>` and subscription `<subscription-id>`.

APIM Developer SKU creation commonly takes 30-45 minutes. The deploy script starts the Azure deployment asynchronously, waits up to 90 minutes, and prints progress while APIM is being created.

## Cost notes

Approximate cost drivers are APIM Developer, Log Analytics ingestion/retention, ACR Premium, private endpoints, the Container Apps environment/control-plane replica, storage capacity/transactions, and any `db-*` Container Apps created by the control plane. The control plane is pinned to one 0.5 CPU / 1 Gi replica.

The durable instance volume is one shared Premium Azure Files NFS share with `shareQuota: 100`. Premium Files has a 100 GiB minimum allocation; in `swedencentral` the Azure Retail Prices API reports Premium LRS provisioned storage at about USD 0.19 per GB-month, so the baseline share is about USD 19/month before transaction/burst charges.

## Tear down

```powershell
.\teardown.ps1
```

Use `-Force` to skip the prompt. The teardown deletes the platform resources and every `db-*` Container App, but never deletes the `<service-resource-group>` resource group.
