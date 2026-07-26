# asmdb Cloud — deployed service notes

> This document describes the asmdb Cloud platform that exists today: the Azure
> resources, request paths, authentication model, instance lifecycle and the
> remaining gaps. The engine itself remains the x86-64 assembly database
> specified in [`ENGINE.md`](ENGINE.md); the service wraps that engine with
> network, identity, routing and storage controls.

---

## 0. Engine envelope — constraints the service cannot loosen

Nothing in the service changes these engine facts. They are compiled into the
binary or into the on-disk format.

<p align="center">
  <img src="assets/asmdb-capacity.png" alt="asmdb capacity, record layout, enforced limits and durability model" width="900">
</p>

| Dimension | Hard limit | Service consequence |
|---|---|---|
| Rows per database | 4 194 304 slots, comfortable to ~3.1 M | A database is a table. Multi-entity applications use multiple instances or their own routing key. |
| Row shape | 256 bytes, seven fixed columns | No per-tenant schema; richer shapes are encoded by the client. |
| `tag` | 39 bytes | Usable as a namespace or partition marker, not arbitrary metadata. |
| `content` | 175 bytes | Documents, embeddings and blobs live elsewhere; the row holds a reference. |
| `value` | one `i64` | The only numeric column, and the only one `RANGE` can filter on. |
| Rows per transaction | 4 096 distinct | Bulk writes must be chunked by the API or the client. |
| Disk per database | ~1 GiB allocated `.dat` on Azure Files NFS, plus `.wal` and `.cdc` | The durable volume must be real; a Container App filesystem is not enough. |
| Concurrency | one writer, unlimited `--reader` sessions | `maxReplicas` is fixed at 1. A second engine process is not extra capacity. |
| Absent from the engine | no SQL, joins, planner, secondary indexes, auth, encryption or audit log | The platform supplies the controls it can; missing database features are not hidden. |

Four consequences are worth keeping visible:

1. `FIND` and `RANGE` are full scans of the slot region. The service must bound,
   cache or index hot predicate queries outside the engine.
2. The change log retention policy is external. Left alone, `<db>.cdc` grows for
   the life of the instance.
3. No transaction spans two instances. Cross-entity consistency is a control-plane
   or application concern.
4. Security is external to the engine. See [`SECURITY.md`](SECURITY.md) for the
   engine and platform threat model.

---

## Table of contents

1. [What is deployed](#1-what-is-deployed)
2. [Network topology](#2-network-topology)
3. [Request routing](#3-request-routing)
4. [Runtime components](#4-runtime-components)
5. [Authentication and tokens](#5-authentication-and-tokens)
6. [Instance lifecycle, storage and isolation](#6-instance-lifecycle-storage-and-isolation)
7. [Observability, stats and costs](#7-observability-stats-and-costs)
7b. [Benchmarking a hosted instance](#7b-benchmarking-a-hosted-instance)
8. [Installation and deployment](#8-installation-and-deployment)
8b. [ALERT — the TLS certificate expires every 90 days](#8b-alert--the-tls-certificate-expires-every-90-days)
8c. [Releasing a new engine version](#8c-releasing-a-new-engine-version)
9. [Durability, upgrade and recovery](#9-durability-upgrade-and-recovery)
10. [Limits and non-goals](#10-limits-and-non-goals)
11. [Verified smoke checks](#11-verified-smoke-checks)
12. [Development plan status](#12-development-plan-status)
13. [Risks and open questions](#13-risks-and-open-questions)
14. [Pricing & packaging](#14-pricing--packaging)

---

## 1. What is deployed

The live platform is in resource group `<service-resource-group>`, region `swedencentral`.

| Resource | Deployed name | Notes |
|---|---|---|
| API Management | `asmdb-apim` | Developer SKU, External VNet mode, gateway `https://asmdb-apim.azure-api.net`, public IP `4.223.65.58`. This is the only public address. |
| Container Apps environment | `asmdb-env` | Internal environment, static IP `10.20.1.197`, domain `<container-apps-env>.swedencentral.azurecontainerapps.io`. That domain does not resolve from the public internet. |
| Virtual network | `asmdb-vnet` | `10.20.0.0/16`, with subnets for Container Apps, APIM and private endpoints. |
| Blob storage | `asmdbstosmwggii` | Control-plane metadata. `publicNetworkAccess: Disabled`, `allowSharedKeyAccess: false`; access is through managed identity. |
| File storage | `asmdbfsosmwggii3rfc4` | Premium FileStorage, NFS 4.1 share `instances`, 100 GiB provisioned. Instance directories are separated by mount sub-path. |
| Container registry | `<registry>` | Premium, because that is the cheapest SKU with private endpoint support. Runtime pulls are private. Public network access remains enabled for ACR Tasks from a workstation. |
| Managed identity | `asmdb-mi` | Used by the control plane. |
| Log Analytics | `asmdb-logs` | Platform logging target. |
| Control plane app | `asmdb-cp` | Ingress is `external: true`, which in an internal Container Apps environment means the environment's private load balancer, not the internet. |

The service is already reachable through APIM for the control-plane paths and
site content listed in [§11](#11-verified-smoke-checks). The public custom
hostname is `https://www.asmdb.cloud`; the apex `asmdb.cloud` redirects
to it at the registrar. The certificate story is deliberately called out in
[§8b](#8b-alert--the-tls-certificate-expires-every-90-days).

---

## 2. Network topology

The topology is intentionally private behind one public front door.

```mermaid
flowchart TB
    Internet["internet"] --> APIM["API Management<br/>asmdb-apim<br/>https://asmdb-apim.azure-api.net<br/>4.223.65.58"]

    subgraph VNET["asmdb-vnet · 10.20.0.0/16"]
        APIMSubnet["APIM subnet<br/>NSG"]
        CASubnet["Container Apps delegated subnet"]
        PESubnet["private endpoints subnet"]

        subgraph CAE["asmdb-env · internal<br/>10.20.1.197"]
            CP["asmdb-cp<br/>control plane"]
            DB["db-&lt;instance&gt;<br/>sidecar + asmdb"]
        end

        BlobPE["Blob private endpoint<br/>+ private DNS zone"]
        NfsPE["NFS private endpoint<br/>+ private DNS zone"]
        AcrPE["ACR private endpoint<br/>+ private DNS zone"]
    end

    APIM -->|HTTPS| CP
    APIM -->|HTTPS /db/&lt;instance&gt;| DB
    CP --> BlobPE
    DB --> NfsPE
    DB -.-> AcrPE

    classDef public fill:#1f6feb,stroke:#0b3d91,color:#fff
    classDef private fill:#1a7f37,stroke:#0b4a20,color:#fff
    classDef store fill:#9a6700,stroke:#5a3d00,color:#fff
    class APIM public
    class CP,DB private
    class BlobPE,NfsPE,AcrPE store
```

Private endpoints exist for Blob storage, the NFS share and the registry, each
with a private DNS zone linked to the VNet. Blob public access is disabled and
shared-key access is disabled. The NFS share carries no account key; it is
reachable only from inside the VNet.

The one exception is the registry. `<registry>` keeps public network access
enabled so images can be built with ACR Tasks from a workstation. Pulls from
running Container Apps go through the private endpoint. Closing that exception
would require a build agent pool inside the VNet, and that is not in place.

---

## 3. Request routing

APIM has two APIs.

| APIM API | Path | Backend | Important policy |
|---|---|---|---|
| `asmdb` | `''` | Control plane `asmdb-cp` | Overrides `Host` to the backend FQDN. |
| `asmdb-instances` | `db` | `https://db-{instance}.<container-apps-env>.swedencentral.azurecontainerapps.io` | Strips `/db/{instance}`, overrides `Host`, and uses a 60-second forward timeout for cold starts. |

A customer receives this base endpoint:

```text
https://www.asmdb.cloud/db/<instance>
```

The data-plane paths sit beneath it:

```text
https://www.asmdb.cloud/db/<instance>/v1/rows
https://www.asmdb.cloud/db/<instance>/mcp
https://www.asmdb.cloud/db/<instance>/health
```

The instance API deliberately has no CORS policy. A browser calling an instance
directly would put the instance bearer token in front-end code. The browser
terminal goes through the control plane instead.

TLS is present on every request hop described here. APIM is HTTPS, APIM forwards
to HTTPS backends, and Container Apps ingress defaults to redirecting HTTP to
HTTPS because `allowInsecure` is not set.

---

## 4. Runtime components

### 4.1 Sidecar

Each database instance runs one sidecar and one `asmdb` process. The sidecar
exposes:

| Endpoint | Purpose |
|---|---|
| REST CRUD under `/v1/rows` | Data-plane row operations. |
| `/mcp` | MCP over HTTP. |
| `POST /v1/exec` | Browser terminal execution path. |
| `GET /v1/stats` | Rows/capacity from the engine and CPU/memory from container cgroups. |
| `/health` | Instance health. |

`GET /v1/stats` accepts a per-instance platform token:

```text
HMAC-SHA256(master secret, instance id)
```

That token is accepted only on `/v1/stats`, never on mutating routes.

### 4.2 Control plane

The control plane exposes:

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Control-plane health. |
| `GET /api/v1/config` | Browser configuration for Entra sign-in. |
| `GET /api/v1/databases` | List databases. |
| `POST /api/v1/databases` | Create a database and return endpoint + token once. |
| `DELETE /api/v1/databases/{id}` | Delete a database. |
| `POST /api/v1/databases/{id}/exec` | Proxy browser terminal commands using the instance token. |
| `POST /api/v1/databases/{id}/rotate-token` | Rotate the instance token. |
| `POST /api/v1/databases/{id}/upgrade` | Backup, restart and upgrade an instance. |
| `GET /api/v1/costs` | Estimated cost view. |

The control-plane image also serves downloadable engine binaries as static
files:

```text
/downloads/manifest.json
/downloads/asmdb-<version>-windows-x64.exe
/downloads/asmdb-<version>-linux-x64
```

The manifest is generated at build time and contains the engine version plus the
filename, byte size and SHA-256 for each binary. Both binaries are assembled
inside the same control-plane image that serves the site, from the same source
tree. That keeps the download page, the manifest and the running fleet on the
same build by construction. The release procedure in [§8c](#8c-releasing-a-new-engine-version)
explains why the image is pinned to the version tag rather than `latest`.

---

## 5. Authentication and tokens

The service uses two credentials. They are not interchangeable.

### 5.1 Management API

Create, list, delete, rotate, upgrade and cost operations require a Microsoft
Entra ID v2 access token. The server verifies the token against the tenant JWKS:
signature, issuer, audience and expiry. The `groups` claim must contain the
object id of the security group named `ASMDB_ADMIN`.

A valid token from a user outside `ASMDB_ADMIN` is rejected with `403`, not
`401`: the user is authenticated, but not authorised. An ID token is not accepted
in place of an access token, and no JWT payload is trusted before signature
verification. If the Entra configuration is absent, the management API fails
closed.

The browser uses authorization-code with PKCE. There is no client secret in the
repository, the image or an app setting. Tenant, client and group ids are read
from environment variables and returned to the browser through `/api/v1/config`.
The previous shared admin key has been removed.

### 5.2 Data plane

A database's own REST API, MCP endpoint and browser terminal use the instance
bearer token. The endpoint and token are returned together once from
`POST /api/v1/databases`. The token is stored by the control plane only as a
hash and is compared in constant time.

Rotation is available at:

```text
POST /api/v1/databases/{id}/rotate-token
```

Rotation is authenticated with Entra, not with the instance token. That is
intentional: rotation is needed when the instance token has been lost. Rotation
restarts the instance and briefly interrupts connections. The new token arrives
as an environment variable, which creates a new container revision, and the
engine holds an exclusive lock until the outgoing process releases it.

---

## 6. Instance lifecycle, storage and isolation

Each instance mounts the durable volume at `/data`. A Container App's own
filesystem is discarded on restart and on scale-to-zero, so running without a
volume would lose the database when the app went idle. The control plane refuses
to start if the volume is not configured.

One Premium FileStorage NFS 4.1 share, `instances`, serves the platform. The
mount sub-path is the instance id, so each database sees only its own directory.
The share is 100 GiB provisioned.

`maxReplicas` is `1` on every tier. This is not a scaling preference; it follows
from the engine. `asmdb` is a single-writer process holding an exclusive lock on
its database. A second replica is a second engine process, and it cannot safely
open the same files while the first one is running.

---

## 7. Observability, stats and costs

Log Analytics is deployed as `asmdb-logs`.

The sidecar's `/v1/stats` endpoint reports rows and capacity from the engine,
plus CPU and memory from the container cgroups. It is protected by the
per-instance platform token described in [§4.1](#41-sidecar).

`GET /api/v1/costs` is an estimate, not an invoice. It is computed from the Azure
Monitor `Replicas` metric, so paused time is excluded by construction. The
estimate uses list rates; it does not claim to be the bill of record.

Metering beyond that estimate is not implemented yet. There is no usage pipeline
that turns per-operation events into invoices.

---

## 7b. Benchmarking a hosted instance

`BENCH` writes real rows into the open database. It replaces the contents with
synthetic rows, so run it against a throwaway database unless the data is
disposable.

The console has a Bench button for this path. To run the same command by hand,
send it through the control-plane exec proxy:

```http
POST https://www.asmdb.cloud/api/v1/databases/{id}/exec
Authorization: Bearer INSTANCE_TOKEN
Content-Type: application/json

{"command": "BENCH 100000"}
```

The command is the engine's own [`BENCH <n>`](COMMANDS.md#bench): it inserts
*n* synthetic rows in a tight in-RAM loop, with no text protocol and no per-row
disk I/O, times that loop inside the engine, then checkpoints once. The result
is the engine insert path for that instance. It is not a measurement of the
browser, the gateway, the REST layer or network latency.

The README's nearly 12 million rows/second figure is an in-RAM insert loop on
one core of a workstation. A hosted `free` instance has 0.25 vCPU, so expect a
fraction of that. Do not compare the number with the README as if the machines
were the same.

Cold start also matters. A `free` or `standard` instance that has scaled to zero
can spend the first 10-20 seconds starting. Warm the instance first, then run
`BENCH` and read the throughput line it returns.

The row ceiling is 4,194,304. `BENCH 1000000` consumes roughly a quarter of the
table's capacity in one command.

---

## 8. Installation and deployment

Deployment is run from a workstation, never from CI.

### 8.1 Prerequisites

- Azure CLI.
- Owner on the target subscription.
- Subscription feature `Microsoft.Network/AllowBringYourOwnPublicIpAddress`
  registered. VNet-injected APIM requires a supplied public IP; without this
  feature the first deployment fails with `SubscriptionNotRegisteredForFeature`.

Register the feature and refresh the provider:

```powershell
az feature register --namespace Microsoft.Network --name AllowBringYourOwnPublicIpAddress
az provider register -n Microsoft.Network
```

Feature registration is asynchronous; wait for it to show as registered before
running the first deployment.

### 8.2 Build the images

Docker is not required on the workstation. `saas/infra/deploy.ps1` builds both
images with ACR Tasks from the repository root, tags them with the engine
version and also writes `latest` as a convenience tag. Releases normally go
through [§8c](#8c-releasing-a-new-engine-version), which runs the tests first.

### 8.3 Run the deployment script

`saas/infra/deploy.ps1` is idempotent and re-runnable. Useful switches:

| Switch | Use |
|---|---|
| `-Tag` | Deploy a specific image tag. |
| `-SkipBuild` | Reuse an existing image. |
| `-SkipApim` | Leave APIM untouched. |
| `-WhatIf` | Preview infrastructure changes. |

APIM Developer takes roughly 30-45 minutes to provision the first time. That is
normal for this SKU and should not be mistaken for a hung deployment.

A VNet cannot be added to an existing Container Apps environment. Moving an
existing environment onto a VNet means deleting its apps and the environment
first. The deployment script detects that shape and refuses rather than
half-applying a private-network migration.

---

## 8b. ALERT — the TLS certificate expires every 90 days

> **`www.asmdb.cloud` is served with a Let's Encrypt certificate that is valid
> for 90 days. If nobody renews it, the site stops loading in every browser
> — not degraded, not slow: refused.** The certificate deployed on
> 2026-07-26 expires on **2026-10-23**. Renew it before then.

### Why this is manual rather than automatic

Two things force it, and neither is a shortcut:

1. **Azure will not issue a managed certificate.** Adding one fails with
   `ManagedCertificateConfigurationTemporaryDisabled` — Microsoft suspended new
   managed-certificate requests, announced through 2026-06-30 and still in force
   past that date. The certificate therefore has to be brought in.
2. **The apex cannot hold the certificate.** DNS forbids a `CNAME` at a zone
   apex, so `asmdb.cloud` is an OVH redirection to `www.asmdb.cloud`, and the
   certificate covers the `www` host that actually terminates TLS.

`deploy.ps1` prints the days remaining on every run and turns red at 21 days.
It **refuses to deploy** with an expired certificate rather than pushing a
broken hostname.

### Renewal procedure

Run this on the machine that holds the ACME account. It takes about five
minutes, most of which is waiting for DNS.

**1 — ask Let's Encrypt for a new challenge**

```powershell
if (-not (Get-Module -ListAvailable Posh-ACME)) {
    Install-Module Posh-ACME -Scope CurrentUser
}
Import-Module Posh-ACME
Set-PAServer LE_PROD
New-PAOrder -Domain 'www.asmdb.cloud' -Force
$auth = Get-PAOrder | Get-PAAuthorization
Get-KeyAuthorization $auth.DNS01Token -ForDNS      # <- the value to publish
```

**2 — publish it at OVH**

OVH control panel → `asmdb.cloud` → **DNS zone** → *Add an entry*:

| Field | Value |
|---|---|
| Type | `TXT` |
| Subdomain | `_acme-challenge.www` |
| Value | the string printed by step 1 |

The full record must read `_acme-challenge.www.asmdb.cloud`. If one is already
there from a previous renewal, **edit it** rather than adding a second — two
TXT records with different values is a common way to fail validation.

**3 — wait for it to be visible, then finish**

```powershell
Resolve-DnsName _acme-challenge.www.asmdb.cloud -Type TXT -Server 8.8.8.8

Send-ChallengeAck $auth.DNS01Url
New-PACertificate -Domain 'www.asmdb.cloud' -PfxPass (New-Guid).Guid
```

**4 — deploy it**

```powershell
.\saas\infra\deploy.ps1 -SkipBuild
```

`deploy.ps1` reads the new certificate out of the local ACME store, base64-encodes
it and passes it as a secure parameter. **The certificate is never written into
the template, a parameter file, or the repository.** Applying a hostname change
on the Developer SKU interrupts the gateway briefly — a few minutes, once.

**5 — check**

```powershell
(Invoke-WebRequest https://www.asmdb.cloud/healthz).StatusCode          # 200
```

### Making it stop being manual

The step that needs a human is publishing the TXT record, and only because OVH
is driven by hand here. Create an **OVH API token** with write access to the
`asmdb.cloud` zone and Posh-ACME will publish and clean up the record itself
(`-Plugin OVH`), at which point renewal is one scheduled command with nothing to
type. Until that exists, this page is the procedure.

#### Automating the OVH DNS step

This trades one risk for another. The manual route stores no DNS credential; the
automated route stores an OVH token with write access to the DNS zone on the
machine that renews the certificate. Keep that machine patched, and scope the
token deliberately.

Create the token at <https://api.ovh.com/createToken/>. It returns three values:

- application key;
- application secret;
- consumer key.

For a European OVH account, the Posh-ACME region is `ovh-eu`. Grant only the
rights the plugin needs:

| Method | Path |
|---|---|
| `GET` | `/domain/zone/*` |
| `POST` | `/domain/zone/*` |
| `DELETE` | `/domain/zone/*` |

Granting `/*` across the whole account is more than this needs. Set the token
validity deliberately; an unlimited token that nobody remembers creating becomes
its own maintenance problem.

The installed Posh-ACME OVH plugin takes secure strings for the two secrets.
Avoid the deprecated insecure parameters (`OVHAppSecretInsecure` and
`OVHConsumerKeyInsecure`) even though examples using them are easy to find; they
put secrets in plain text.

Create or replace the order with the plugin arguments:

```powershell
Import-Module Posh-ACME
Set-PAServer LE_PROD

$pluginArgs = @{
    OVHAppKey      = '<application-key>'
    OVHAppSecret   = ConvertTo-SecureString '<application-secret>' -AsPlainText -Force
    OVHConsumerKey = ConvertTo-SecureString '<consumer-key>' -AsPlainText -Force
    OVHRegion      = 'ovh-eu'
}

New-PACertificate -Domain 'www.asmdb.cloud' `
    -Plugin OVH `
    -PluginArgs $pluginArgs `
    -PfxPass (New-Guid).Guid `
    -Force
```

Posh-ACME stores the plugin arguments with the order, so later renewals do not
need the hashtable again:

```powershell
Submit-Renewal
```

That is the whole point: no TXT value to copy, no DNS record to type. It still
has to run somewhere. Posh-ACME does not renew by itself; use a scheduled task
on a machine that is on, or renewal will not happen.

After renewal, deploy the certificate as usual:

```powershell
.\saas\infra\deploy.ps1 -SkipBuild
```

The deployment script reads the renewed certificate from the ACME store and
passes it to Azure, the same as in the manual procedure.

---

## 8c. Releasing a new engine version

One version number drives everything: the binaries on the download page, the
image instances run, and whether an upgrade is offered. It lives in
**`src/asmdb.inc`**:

```nasm
%define ENGINE_MAJOR 1
%define ENGINE_MINOR 5
%define ENGINE_PATCH 2
```

`scripts/release.ps1` reads it and uses it as the release tag. That is not
cosmetic. The control plane offers an upgrade when an instance's recorded image
differs from the current `ASMDB_IMAGE`, so **a tag of `latest` would make upgrades
impossible** — `latest` never differs from itself. Pinning the version tag is
what makes the upgrade path work at all.

It also makes the download page and the running fleet agree by construction:
both binaries are assembled from the same source tree inside the same image
that serves the site, so `/downloads/` cannot advertise a build that is not the
one the platform is running.

### The procedure

**1 — bump the version and make the change**

Edit `ENGINE_MAJOR` / `ENGINE_MINOR` / `ENGINE_PATCH` in `src/asmdb.inc`. The
pre-1.0 rule in that file still applies to the on-disk `DB_VERSION`, which moves
almost never and only when the layout changes.

**2 — prove it before shipping it**

```powershell
.\scripts\build.ps1
.\tests\smoke.ps1          # must report 151 checks, 0 failures
```

and on Linux, `./scripts/build.sh && ./tests/smoke.sh`. A release that has not
run the suite is not a release.

**3 — record it**

Update the changelog in `README.md`. Every behaviour-changing commit does this;
a release doubly so.

**4 — deploy**

```powershell
.\scripts\release.ps1
```

which, without further arguments:

- reads the version from `src/asmdb.inc` and prints it as the release tag;
- assembles both binaries and both images from that source;
- pushes each image twice, as `<version>` and as `latest`;
- calls `saas/infra/deploy.ps1` so `ASMDB_IMAGE` points at the **version** tag.

**5 — what happens on its own**

- `/downloads/manifest.json` and the two binaries beneath it are the new
  version. The page reads the manifest, so it cannot claim otherwise.
- Every instance still running the previous tag now reports
  `"upgradeAvailable": true`, with `engine` showing what it runs and
  `availableEngine` what it could run.
- New databases are created on the new version.

**6 — existing databases upgrade when their owner asks**

`POST /api/v1/databases/{id}/upgrade` takes a `BACKUP` first and aborts if that
fails, then moves the container app to the new image. The volume is NFS and
persists, so the new engine opens the existing files; if the on-disk format
moved, the engine's own `--upgrade` path migrates them.

Upgrading **restarts the instance and interrupts connections**. The engine holds
an exclusive lock and runs at `maxReplicas: 1`, so the replacement cannot open
the database until the outgoing process releases it. This is not zero-downtime
and is not presented as such. Nobody is upgraded without asking.

### Rolling back

Deploy with the previous tag explicitly:

```powershell
.\saas\infra\deploy.ps1 -Tag 1.5.0
```

The image is still in the registry, so this points `ASMDB_IMAGE` back and the
same upgrade endpoint moves an instance onto it. **A rollback across a
`DB_VERSION` change is not safe** — an older engine refuses a newer file rather
than guessing at it, which is the correct behaviour and the reason the backup in
step 6 is taken before anything moves.

---

## 9. Durability, upgrade and recovery

The live database files are on the durable NFS volume. That is the durability
mechanism that exists today beyond the engine's own `.dat`, `.wal` and `.cdc`
files. Backup shipping, PITR and invoice-grade usage metering are not deployed.

Upgrade is deliberately conservative. `POST /api/v1/databases/{id}/upgrade`
takes a `BACKUP` before changing anything and aborts if the backup fails. The
operation restarts the instance, so it is not seamless; active connections can
be interrupted while the old process exits, the lock is released and the new
revision starts.

---

## 10. Limits and non-goals

- There is no public address except APIM.
- There is no direct browser access to an instance API, by design.
- There is no CORS policy on `asmdb-instances`, by design.
- There is no build agent pool inside the VNet; ACR public access remains enabled
  for workstation-triggered ACR Tasks.
- There is no read-replica story for a single instance while `maxReplicas` is 1.
- There is no metering pipeline beyond the Azure Monitor cost estimate.
- There are no deployed backups beyond the provisioned NFS share and the backup
  taken before upgrade.
- There are no compliance certifications claimed here.

---

## 11. Verified smoke checks

The following have been proven through `https://www.asmdb.cloud`:

| Request | Result |
|---|---|
| `GET /healthz` | `200 ok` |
| `GET /` | site returned |
| `GET /api/v1/databases` | `200 {"databases":[]}` |

---

## 12. Development plan status

The original plan was organised as waves. The useful part now is the status of
what landed versus what remains.

```mermaid
flowchart TB
    subgraph LANDED["landed"]
        Contracts["contracts"]
        Sidecar["sidecar<br/>REST · MCP · exec · stats"]
        Control["control plane<br/>databases · rotate · upgrade · costs"]
        Infra["infrastructure<br/>ACA · APIM · VNet"]
        Network["private endpoints<br/>Blob · NFS · ACR pulls"]
        Site["site through gateway"]
        Auth["Entra management auth<br/>PKCE browser flow"]
        Terminal["browser terminal"]
    end

    subgraph NOTYET["not landed"]
        Metering["invoice-grade metering"]
        Backups["backup/PITR beyond NFS<br/>and pre-upgrade BACKUP"]
        BuildPool["build agent inside VNet"]
        Replicas["read replicas / failover"]
        ShareGrowth["automated share growth"]
        Prealloc["preallocation economics"]
    end

    Contracts --> Sidecar --> Control --> Infra --> Network --> Auth
    Control --> Site
    Control --> Terminal
```

| Area | Status |
|---|---|
| Contracts | Landed. The control-plane and sidecar surfaces exist. |
| Sidecar | Landed: REST CRUD, MCP over HTTP, browser `exec`, health, stats from engine + cgroups. |
| Control plane | Landed: health, config, database create/list/delete, exec proxy, rotate, upgrade, costs. |
| Infrastructure | Landed: resource group, VNet, internal Container Apps environment, APIM, managed identity, Log Analytics. |
| Private network and gateway | Landed: APIM is public; Container Apps, Blob, NFS and runtime pulls are private. |
| Site | Landed through `GET /` on the APIM gateway. |
| Authentication | Landed: Entra access-token verification with `ASMDB_ADMIN`, PKCE browser flow, hashed instance tokens. |
| Browser terminal | Landed through the control-plane proxy. |
| Stats and cost view | Landed as stats endpoint and Azure Monitor `Replicas` estimate. |
| Metering beyond estimate | Not landed. There is no invoice-grade usage pipeline. |
| Backups beyond provisioned share | Not landed, except the explicit `BACKUP` before upgrade. |
| Build agent inside VNet | Not landed; ACR public network access remains enabled for workstation builds. |
| Read replicas / failover | Not landed and incompatible with the current `maxReplicas: 1` instance shape. |
| Grow the instance share ahead of demand | Not automated. Premium Files bills on provisioned capacity, so capacity must be added before the share fills — roughly 100 databases per 100 GiB. |
| Revisit the engine's 1 GiB preallocation | Open question. The slot region drives the per-database GiB; a smaller region, or storage that honours sparseness, would change the economics. |

---

## 13. Risks and open questions

- **Single table per instance.** A database is a table, so a tenant with multiple
  entities needs multiple instances or an application-level encoding.
- **Full scans.** `FIND` and `RANGE` remain full scans. Hot predicates need a
  service-side index, cache or a future engine index.
- **One writer.** One instance cannot scale writes horizontally. Partitioning is
  the only deployed-compatible answer today.
- **ACR public build path.** Runtime pulls are private, but workstation ACR Tasks
  require the registry public endpoint until a build pool exists inside the VNet.
- **Cost estimate.** The current view excludes paused time by construction, but
  it is not an invoice.

---

## 14. Pricing & packaging

The planned public packaging has three tiers, priced from Azure list rates at **15 % margin on run**.
The derivation — every rate, every assumption, and what would break the model —
is in [`COST.md`](COST.md).

| Tier | Price | Size | Behaviour | Cap |
|---|---|---|---|---|
| **Free** | $0 | 0.25 vCPU / 0.5 GiB | sleeps when idle | 3 per account |
| **Standard** | $15/mo | 0.5 vCPU / 1 GiB | sleeps when idle | 20 per account |
| **Premium** | $49/mo | 1 vCPU / 2 GiB | always warm, no cold start | 100 per account |

Every tier runs the identical engine, with the same 4 194 304-row ceiling and
the same durability. Tiers buy **latency and headroom, not features** — there is
no paid feature flag in the codebase and there is not meant to be one. The site
may list planned GA rows such as Microsoft Fabric Workload and automated
backups; those are not deployed capabilities today.

The sizes are not free choices. Container Apps Consumption accepts only fixed
vCPU/memory pairs at a 1:2 ratio and **0.25 vCPU / 0.5 GiB is the floor**, so
there is nothing smaller to sell; the only lever below it is not running, which
is what scale-to-zero does.

`Premium` costs 3.6× `Standard` for 2× the CPU because it never scales to zero.
About $21/month of its cost is a replica sitting idle so the first request does
not wait. That is the product.

Two economics worth stating plainly:

- **The free tier is not free to run.** About $1.20/month each, funded by the
  paying tiers. The three-instance cap is a pricing control, not a technical
  limit.
- **This is a volume model.** Fixed platform cost is about $142/month before
  per-database storage, so it stops dominating at roughly **150 databases**.
  Below that the standard tier loses money.

### Later tiers, not yet built

| Tier | Isolation | Durability/HA | Price model |
|---|---|---|---|
| **Premium+** | container, read replica | ≤5 s RPO | usage + reserved capacity |
| **Enterprise** | Firecracker micro-VM, dedicated nodes | warm standby, residency, SSO, audit export | annual contract + usage |

Ground any latency or throughput claim in the measured
[README benchmark](../README.md#performance) numbers, and don't promise the
bulk-durable path until incremental checkpointing lands.

---
