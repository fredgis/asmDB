# Installing asmDB Analytical Capabilities

Use this document in two ways:

- **First install:** complete **Part 1 — One-time setup**, then **Part 2 — Every release**.
- **Upgrade/re-release:** skip straight to **Part 2 — Every release** unless the domain, Entra app, tenant settings, capacity, or Key Vault changed.

The goal is one uploadable file and no guesswork: `workload\build\pack.ps1` builds, validates, packages, and prints the exact `.nupkg` path to upload.

## Values that must match across components

| Value | Current value | Where it must match | Failure if wrong |
|---|---|---|---|
| Workload name | `Org.AsmdbAnalytical` | workload manifest, item manifest, Entra redirect URIs, frontend workload constants | Authentication or navigation silently targets the wrong workload. |
| Item editor path | `/sync-hub` | `workload/manifest/items/SyncHub/SyncHubItem.json` and `workload/frontend/src/workload-constants.ts` `SYNC_HUB_EDITOR_PATH` | Fabric opens a blank editor panel. |
| Frontend dev port | `60006` | Vite dev server and localhost redirect URI `http://localhost:60006/close` | Local sign-in callback never closes. |
| Azure subscription | `<subscription-id>` | `deploy.ps1 -SubscriptionId` and verification commands | Resources are checked or created in the wrong subscription. |
| Analytics resource group | `<analytics-resource-group>` in `swedencentral` | `deploy.ps1 -ResourceGroup`; never `<service-resource-group>` | The workload is no longer isolated from asmDB Cloud. |

## What is already deployed

The reference environment is provisioned. These are the real values; substitute your own when installing into a different tenant.

| Component | Value | Verified by |
|---|---|---|
| Verified Entra domain | `asmdb.cloud` | `az rest --url https://graph.microsoft.com/v1.0/domains` |
| Entra app (multitenant) | `<workload-app-id>` | `az ad app show --id …` |
| Application ID URI | `https://asmdb.cloud/fe/be/Org.AsmdbAnalytical/1` | same |
| Exposed scope | `FabricWorkloadControl`; preauthorise Power BI `871c010f-5e61-4fb1-83ac-98610a7e9110`, Fabric Client for Workloads `d2450708-699c-41e3-8077-b0c8341509aa`, and Power BI Service `00000009-0000-0000-c000-000000000000`; delegated `Fabric.Extend` consented | same |
| Federated credential | subject `<backend-mi-principal-id>` (backend managed identity), audience `api://AzureADTokenExchange` | `…/federatedIdentityCredentials` |
| Key Vault | `<key-vault-name>`, **RBAC authorisation enabled**, public network access disabled | `az keyvault show` |
| Key Vault grant | workspace identity `<fabric-workspace-name>` / `<workspace-identity-object-id>` → **Key Vault Secrets User** | `az role assignment list --scope <vault>` |
| Backend | `https://asmdb-analytical-backend.azurewebsites.net` | `/health` returns `{"status":"ok","version":"0.1.0"}` |
| Frontend | `https://fe.asmdb.cloud` | `/`, `/sync-hub` and `/close` all return 200 over HTTPS |
| CDC gateway | internal Container App in `<service-resource-group>`, uid `100:101`, read-only NFS mount | `/cdc/{id}` and `/snapshot/{id}` answered through the backend passthrough |
| Notebook data path | `ASMDB_NOTEBOOK_GATEWAY_URL` = `…/api/sync` | a snapshot of a live instance returns `X-Asmdb-Snapshot-Seq` matching the change log's head |

One thing is deliberately **not** production-ready:

- **Real support links.** Three still read `REPLACE-ME`, and the three GitHub links resolve only while the repository is private. Neither blocks a tenant-internal install; both block Workload Hub submission.

The CDC gateway **is deployed**, but it is the deliberate exception to the analytics-resource-group split: it lives in `<service-resource-group>` alongside the service because it mounts the same Azure Files share, and it is private to the service VNet. Notebooks therefore read through the backend rather than calling it directly — see §4.2, which also records why the obvious alternative does not work.

## Decisions to make before first upload

### Workload name is permanently locked

The workload name is reserved in the tenant on first upload confirmation and cannot be changed afterwards. The current build single source of truth is `workload/build/workload.settings.json`:

```json
"workloadId": "Org.AsmdbAnalytical"
```

The `Org.` prefix is the documented convention for single-tenant internal use. Cross-tenant Workload Hub publication uses `[Publisher].[Workload]`, for example `Asmdb.AnalyticalCapabilities`. Do **not** rename casually: decide before first upload. If it changes, edit `workload/build/workload.settings.json` once, then run `pack.ps1`; preflight lists every manifest/frontend occurrence that still disagrees.

### Workload Hub has business prerequisites, not just manifest fields

Workload Hub publication requires a published Marketplace offer — SaaS offer on Azure Marketplace or AppSource — plus terms-of-use, privacy, attestation/certification, help, license, and documentation links that return HTTP 200–399 over HTTPS. Microsoft Learn documents the publication requirements; it does **not** publish a fixed turnaround time for Microsoft review.

The current `REPLACE-ME` support links are therefore gated prerequisites, not last-minute text edits:

| Link | Current placeholder | Owner/work item |
|---|---|---|
| Certification / attestation | `https://REPLACE-ME.example.com/certification` | Marketplace/publication owner |
| Privacy | `https://REPLACE-ME.example.com/privacy` | Legal/product owner |
| Terms | `https://REPLACE-ME.example.com/terms` | Legal/product owner |

### The GitHub support links do not resolve today, because the repository is private

Three support links point at `github.com/fredgis/asmDB` — documentation, help, and license. All three return **404 to anonymous callers**, because GitHub answers 404 rather than 403 for a private repository so as not to disclose that it exists.

They resolve for you, signed in, which is exactly what makes this easy to miss. They will not resolve for a Microsoft reviewer. The packaging preflight checks them over the network for this reason.

Two ways out, and the choice is a product decision rather than a technical one:

- make the repository public, which is the simplest option if it is intended to be an open project;
- or host the pages under `asmdb.cloud`, which you already own and have to verify in Entra anyway.

Sources to verify: Microsoft Learn `fabric/extensibility-toolkit/publishing-requirements-general` and Fabric Workload Hub publishing documentation.

---

# Part 1 — One-time setup for a first install

## 1. Install local tools

What to do:

```powershell
node --version
npm --version
pwsh --version
az --version
```

Required versions/tools:

- Node.js 20+ with npm.
- PowerShell 7+.
- Azure CLI.
- PowerShell/.NET runtime capable of creating zip packages. PowerShell 7 supplies this.

How to know it worked: every command prints a version, and Node is 20 or higher.

Failure looks like: `not recognized`, `command not found`, or Node lower than 20. Install Node from `https://nodejs.org/`, PowerShell from `https://learn.microsoft.com/powershell/`, and Azure CLI from `https://learn.microsoft.com/cli/azure/install-azure-cli`.

## 2. Verify the Entra domain and publishing identity

Microsoft separates four concepts that are often confused:

| Concept | What it is | Internal org publishing | Workload Hub cross-tenant publishing |
|---|---|---|---|
| Verified custom domain in the Entra tenant | DNS TXT/MX record proving ownership | Required | Required |
| Publisher domain on the app registration | Domain shown on the consent prompt | Recommended | Required; must not be `*.onmicrosoft.com` |
| Publisher verification blue badge | Links a verified Partner account to the app | Not required | Required |
| Partner Program / CPP / MPN membership | Mechanism behind the badge | Not required | Required |

Microsoft states the domain requirements apply to **all** publishing scenarios, internal and cross-tenant. Documented constraints:

- Application ID URI must match the verified domain.
- Frontend domain must be a subdomain of the verified Entra domain.
- No `*.onmicrosoft.com` subdomains.
- **Exactly one label beyond the verified domain.** Fabric strips the first label of the frontend host and requires the remainder to be a verified tenant domain.

For asmDB the verified domain is `asmdb.cloud`, so use this shape:

```text
verified domain   asmdb.cloud
frontend          https://fe.asmdb.cloud/
redirect URI      https://fe.asmdb.cloud/close
App ID URI        https://asmdb.cloud/fe/be/Org.AsmdbAnalytical/1
```

`fe.workload.asmdb.cloud` looks reasonable and is **rejected**, because two labels sit between the host and the verified domain. The upload fails with:

```text
Frontend Uri domain workload.asmdb.cloud is not in the tenant domains list
```

That message names a host nobody configured — `asmdb.cloud` is simply what remains after Fabric removes `fe`. If you see a domain you never typed, this is why. The packaging preflight now enforces the same rule, so the failure happens locally rather than at upload.

A default Azure hostname such as `*.azurestaticapps.net` or `*.azurecontainerapps.io` does **not** satisfy the Fabric publishing requirement. The hosting resource must have a custom domain under `asmdb.cloud` before packaging for upload.

Sources to verify: Microsoft Learn `fabric/extensibility-toolkit/publishing-requirements-general`, Microsoft Entra custom domain documentation, and Microsoft Entra publisher verification documentation.

### 2.1 Verify `asmdb.cloud` in the Entra tenant — lead-time item

**Start this first. DNS propagation can take hours.** Microsoft guidance says to wait at least one hour; in practice it can be about 15 minutes to several hours.

Portal path: **Microsoft Entra admin center** → **Identity** → **Settings** → **Domain names** → **Add custom domain**.

Required role: Domain Name Administrator.

What to do:

1. Add `asmdb.cloud`.
2. Copy the TXT record issued by the portal, in the form `MS=ms########`.
3. Create that TXT record at the domain registrar/DNS host. Microsoft shows TTL 3600.
4. Return to Entra and verify the domain.

CLI equivalent:

```powershell
az rest --method POST `
  --url "https://graph.microsoft.com/v1.0/domains" `
  --body '{ "id": "asmdb.cloud" }'

az rest --method GET `
  --url "https://graph.microsoft.com/v1.0/domains/asmdb.cloud/verificationDnsRecords"
```

How to know it worked: Entra shows `asmdb.cloud` as **Verified**.

Failure looks like: the portal cannot verify the TXT record, or DNS lookup does not show `MS=ms########`. Wait for propagation and confirm the TXT record is on the correct DNS zone.

### 2.2 Create or update the Entra app after the domain is verified

Portal path: **Microsoft Entra admin center** → **Identity** → **Applications** → **App registrations** → **asmDB Analytical Capabilities**.

What to do: create or update the app only after `asmdb.cloud` is verified. If the app is created first, it does not inherit the verified domain automatically; you must go back and set the publisher domain manually.

CLI equivalent:

```powershell
pwsh .\workload\build\deploy.ps1 `
  -Only entra `
  -TenantId "<tenant-guid>" `
  -CustomDomain "fe.asmdb.cloud"
```

How to know it worked: the app registration publisher domain is `asmdb.cloud`, not an `*.onmicrosoft.com` domain.

Failure looks like: the consent prompt shows an `*.onmicrosoft.com` publisher, or Fabric sign-in targets an app whose redirect URI/domain does not match the verified domain.

### 2.3 Set the App ID URI to the verified-domain form

Portal path: **App registrations** → **asmDB Analytical Capabilities** → **Expose an API** → **Application ID URI**.

Value:

```text
https://asmdb.cloud/fe/be/Org.AsmdbAnalytical/1
```

CLI equivalent:

```powershell
az ad app update `
  --id "<app-id>" `
  --identifier-uris "https://asmdb.cloud/fe/be/Org.AsmdbAnalytical/1"
```

How to know it worked: the Application ID URI begins with `https://asmdb.cloud/` and contains the current workload id. The host is exactly the verified domain; `fe` and `be` are path segments, not subdomains.

Failure looks like: an `api://...` URI, an Azure-assigned/default domain, or a subdomain such as `https://workload.asmdb.cloud/...` remains. Those do not satisfy Fabric's publishing requirement.

### 2.3.1 Expose the workload scope and preauthorise Fabric clients

The workload app must expose `FabricWorkloadControl` and preauthorise the Microsoft clients that Fabric/Power BI use to request it:

| Client | App id | Why |
|---|---|---|
| Power BI | `871c010f-5e61-4fb1-83ac-98610a7e9110` | Power BI frontend/client path. |
| Fabric Client for Workloads | `d2450708-699c-41e3-8077-b0c8341509aa` | Current Fabric workload control-plane client. |
| Power BI Service | `00000009-0000-0000-c000-000000000000` | Legacy/service path still required by Fabric workload authentication guidance. |

Also add and consent delegated Power BI Service permission `Fabric.Extend`. Without it Fabric can upload and load enough of the workload to mislead you, then fail token acquisition.

After running `deploy.ps1 -Only entra`, verify this by hand: inspect **Expose an API** → **Authorized client applications** and **API permissions** → admin consent. If any client or `Fabric.Extend` is missing, add it before packaging; token acquisition failures otherwise look like generic workload auth errors.


### 2.4 Complete publisher verification for Workload Hub only — lead-time item

**Start this early for Hub publication. Partner Program identity verification is documented as a 1–5 business day lead-time item.** Microsoft review turnaround beyond that is not published.

Portal path: **Microsoft Entra admin center** → **App registrations** → app → **Branding & properties** / **Publisher verification**.

CLI equivalent: Microsoft documents publisher verification as a portal/Partner Center flow; no single Azure CLI command completes the Partner verification and badge process.

How to know it worked: the app registration shows the verified publisher badge.

Failure looks like: cross-tenant Workload Hub publication is blocked even though internal tenant testing works.

### 2.5 Point DNS at the frontend, then attach the custom domain

Two steps in a fixed order: the DNS record must exist and resolve *before* Azure will accept the hostname, because attaching it triggers a validation that reads DNS.

#### 2.5.1 Create the CNAME at the DNS provider

`asmdb.cloud` is hosted at **OVH**, not Azure DNS, so this record cannot be created with `az`. In the OVH control panel, under the `asmdb.cloud` zone:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Sub-domain | `fe` |
| Target | `<static-web-app>.azurestaticapps.net` (for this deployment, `<static-web-app>.7.azurestaticapps.net`) |
| TTL | 3600 |

Find the target with:

```powershell
az staticwebapp show `
  --subscription <subscription-id> `
  --resource-group <analytics-resource-group> `
  --name asmdb-analytical-frontend `
  --query defaultHostname -o tsv
```

Confirm it has propagated before continuing, querying a public resolver rather than your own cache:

```powershell
Resolve-DnsName -Name fe.asmdb.cloud -Type CNAME -Server 8.8.8.8
```

The answer must show `NameHost` equal to the Static Web App hostname. **Only one label may precede `asmdb.cloud`** — see the domain rule above; `fe.workload` is two and Fabric rejects it at upload.

#### 2.5.2 Attach the hostname to the Static Web App

```powershell
az staticwebapp hostname set `
  --subscription <subscription-id> `
  --resource-group <analytics-resource-group> `
  --name asmdb-analytical-frontend `
  --hostname "fe.asmdb.cloud"
```

This is not instant. The hostname moves through `RetrievingValidationToken` → `Validating` → `Adding` → `Ready`, taking roughly five minutes in practice, and Azure issues a managed TLS certificate along the way. Poll it rather than assuming:

```powershell
az staticwebapp hostname list `
  --subscription <subscription-id> `
  --resource-group <analytics-resource-group> `
  --name asmdb-analytical-frontend `
  --query "[].{name:name,status:status}" -o table
```

**How to know it worked:** the status reads `Ready`, and all three routes answer 200 over HTTPS:

```powershell
foreach ($p in '/','/sync-hub','/close') {
  (Invoke-WebRequest "https://fe.asmdb.cloud$p" -TimeoutSec 30).StatusCode
}
```

`/sync-hub` matters as much as `/`. It exercises the static-host fallback: without it Fabric navigates the editor iframe to a path the host does not serve and the panel renders blank with nothing in the console.

**Failure looks like:**

- the hostname sticks at `Validating` — the CNAME is missing, wrong, or not yet propagated. Re-run the `Resolve-DnsName` check against an external resolver;
- HTTPS fails while HTTP works — the managed certificate has not finished issuing. Wait for `Ready`;
- `/` returns 200 but `/sync-hub` returns 404 — the fallback configuration did not ship. Confirm `staticwebapp.config.json` is present in the deployed output;
- the manifest still points at `*.azurestaticapps.net`, `*.azurecontainerapps.io` or `*.onmicrosoft.com` — `pack.ps1` fails the frontend-domain preflight before producing a package.

## 3. Verify the isolated Azure resource group

What to do:

Azure portal path: **Azure Portal** → **Resource groups** → select subscription `<subscription-name>` → open `<analytics-resource-group>`.

CLI equivalent, read-only:

```powershell
az group show `
  --subscription <subscription-id> `
  --name <analytics-resource-group> `
  --output table

az resource list `
  --subscription <subscription-id> `
  --resource-group <analytics-resource-group> `
  --query "[].{name:name,type:type,location:location}" `
  --output table
```

How to know it worked: the group location is `swedencentral`. Before first deployment, the resource list may be empty.

Failure looks like: `ResourceGroupNotFound`, wrong subscription, or the group name `<service-resource-group>`. Stop if that happens; do not deploy analytics resources into `<service-resource-group>`.

## 4. Create or verify Azure hosting infrastructure

What to do: after the resource group exists, use the deployment script for infrastructure. It verifies `<analytics-resource-group>` and refuses to create the resource group automatically.

```powershell
pwsh .\workload\build\deploy.ps1 `
  -Only infrastructure `
  -SubscriptionId <subscription-id>
```

Azure portal path: **Azure Portal** → **Resource groups** → `<analytics-resource-group>` → verify the backend App Service and Static Web App.

CLI equivalent checks:

```powershell
az resource list `
  --subscription <subscription-id> `
  --resource-group <analytics-resource-group> `
  --output table
```

How to know it worked: the backend App Service and Static Web App are in `<analytics-resource-group>`, not `<service-resource-group>`.

Failure looks like: the script says the resource group is missing or an isolation violation occurred. Stop and fix the subscription/resource-group parameters.

### 4.1 Reaching the CDC gateway, which is private

The CDC gateway is the one component that does **not** live in the analytics resource group. It reads the change log from a read-only mount of the Azure Files share the asmDB Cloud instances write to, and that share is in `<service-resource-group>` — so the gateway is there too, in an **internal** Container Apps environment, on a private address inside `asmdb-vnet` with no public DNS.

That is the desired shape: the gateway is never exposed to the internet. It does mean the backend cannot reach it by default, and the CDC preview reports an unavailable dependency until this step is done.

**Regional VNet integration is the mechanism, not a private endpoint.** A private endpoint governs *inbound* traffic to a resource; the problem here is *outbound* — App Service reaching a private address. VNet integration is the only way an App Service can route to one.

It is nonetheless additive, which is what matters for a resource group running a live service: it creates a new subnet and enables outbound integration on the workload's own app. No existing resource is reconfigured, and nothing becomes public.

`deploy.ps1 -Only infrastructure` performs all three steps. Manually:

```powershell
az network vnet subnet create `
  --resource-group <service-resource-group> --vnet-name asmdb-vnet `
  --name snet-appsvc --address-prefixes 10.20.6.0/24 `
  --delegations Microsoft.Web/serverFarms

az webapp vnet-integration add `
  --resource-group <analytics-resource-group> --name asmdb-analytical-backend `
  --vnet "/subscriptions/<sub>/resourceGroups/<service-resource-group>/providers/Microsoft.Network/virtualNetworks/asmdb-vnet" `
  --subnet snet-appsvc

az webapp config set `
  --resource-group <analytics-resource-group> --name asmdb-analytical-backend `
  --vnet-route-all-enabled true
```

Then set `ASMDB_GATEWAY_URL` to the gateway's internal FQDN and `ASMDB_GATEWAY_TOKEN` to its bearer token, and restart.

Name resolution needs no work: Azure already links the Container Apps environment's private DNS zone to `asmdb-vnet`, so once the app routes through the VNet it resolves the gateway to its private IP.

**How to know it worked** — verify from inside the App Service rather than trusting the configuration:

```powershell
$tok = az account get-access-token --resource https://management.azure.com --query accessToken -o tsv
$cmd = 'curl -s -w "\nHTTP=%{http_code}\n" --max-time 20 https://<gateway-fqdn>/healthz'
Invoke-RestMethod -Uri "https://asmdb-analytical-backend.scm.azurewebsites.net/api/command" -Method Post `
  -Headers @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" } `
  -Body (@{ command = $cmd; dir = "/home" } | ConvertTo-Json)
```

Expect `{"status":"ok"}` and `HTTP=200`. Resolving the hostname to a `10.20.*` address confirms the private path is in use.

**Failure looks like:**

- the name resolves to a public address, or not at all — the app is not routing through the VNet. Check `vnet-route-all-enabled`;
- the name resolves but the connection times out — the subnet delegation or the integration did not take;
- everything resolves but the gateway answers 401 — the bearer token is wrong, which is a configuration problem rather than a network one.

**A note on the token.** It is set as an application setting rather than a Key Vault reference. The vault has public network access disabled by tenant policy and is reachable only through the Fabric managed private endpoint, so App Service cannot read it. A Key Vault reference would fail at startup. This is a deliberate trade-off, not an oversight: revisit it if a private endpoint for App Service is added to the vault.

### 4.2 Letting the Spark notebooks reach the gateway, which is a different path entirely

§4.1 solves the **backend's** route to the gateway. It does nothing for the notebooks, and the distinction is easy to miss because both are "our code calling the gateway".

The backend is an App Service we own, sitting in a subnet we created, so outbound VNet integration is available to it. A Fabric notebook is not ours: it runs on Spark inside Microsoft's own managed network, in a different region from the gateway. It cannot be placed in `asmdb-vnet`, and no setting on the notebook will change that.

Left alone, the sync notebook fails on its first HTTP call, and Fabric reports it as:

```
System cancelled the Spark session due to statement execution failures
Code: System_Cancelled_Session_Statements_Failed
```

That message names the symptom and not the cause, which is why this section exists.

#### A managed private endpoint does not solve this, and it is worth knowing why

The obvious move is the mechanism already used for Key Vault: a Fabric managed private endpoint. It can be created against the Container Apps environment, Azure will approve it, and both sides will report success:

```powershell
az network private-link-resource list --id "<managedEnvironmentId>" -o json
# groupId: managedEnvironments
# requiredZoneNames: privatelink.<region>.azurecontainerapps.io
```

**It still does not work, and it fails silently.** Private Link is only half a mechanism; the other half is DNS. Fabric creates and links private DNS zones automatically for the resource types it supports — Storage, SQL, Key Vault, Cosmos DB and their siblings — and Container Apps is not among them. The endpoint is provisioned, approved, and unreachable.

Measured from inside a Spark session, after the endpoint reported `Succeeded` and `Approved` on both sides:

```
asmdb-cdc-gateway.<env>.swedencentral.azurecontainerapps.io -> 51.107.183.214
<env>.privatelink.swedencentral.azurecontainerapps.io       -> 51.107.183.214
HTTP FAILED: SSLError ... UNEXPECTED_EOF_WHILE_READING
```

Both names resolve to the **public** address, so no private DNS zone is in effect. The connection then reaches the public Container Apps edge, which serves nothing for an internal environment and drops the TLS handshake — hence an SSL error rather than a connection refusal, which is what makes this so easy to misdiagnose as a certificate problem.

Do not spend time on this path. It is documented here so that the next person does not repeat the experiment.

#### What actually works: the notebooks read through the backend

The backend already reaches the gateway, over the VNet integration of §4.1, and it is publicly reachable. So generated notebooks read their change log through it rather than calling the gateway directly.

`ASMDB_NOTEBOOK_GATEWAY_URL` is the base URL baked into every generated notebook. Point it at the backend's passthrough:

```powershell
az webapp config appsettings set `
  --resource-group <analytics-resource-group> --name asmdb-analytical-backend `
  --settings ASMDB_NOTEBOOK_GATEWAY_URL="https://asmdb-analytical-backend.azurewebsites.net/api/sync"
```

The route mirrors the gateway's own contract — `GET /cdc/{instanceId}?from=&limit=` returning NDJSON with the `x-asmdb-*` headers — so the notebook's parsing, its gap and corruption handling, and its tests all stay as they are. Only the base URL differs.

**Two routes, not one.** `/api/sync/snapshot/{instanceId}?after=&limit=` passes the gateway's snapshot through as well, and it is not optional: without it a notebook cannot recover from `TRUNCATE`, `RESTORE` or `BENCH`, because each of those replaces the table and the engine reports it as a single `RESET` frame carrying no rows. The snapshot's `X-Asmdb-Snapshot-Seq` is what lets the notebook seed and then resume incremental consumption with no gap. Forward that header along with `X-Asmdb-Rows`, `X-Asmdb-Live-Rows`, `X-Asmdb-Has-More` and `X-Asmdb-Next-After` — a header the passthrough drops is a page the notebook cannot follow.

If the setting is absent the notebooks fall back to `ASMDB_GATEWAY_URL`, which is correct only where Spark can route into the VNet. Set it explicitly.

**Do not make the passthrough stricter than the gateway.** The notebook asks for a page of 5000 frames; the gateway caps a page at 1000 and advertises the rest through `x-asmdb-has-more`, so it accepts the larger number and simply returns fewer. The first version of this route validated the limit at 1000 and returned `400`, which broke every sync. Clamp, do not reject.

**Authentication is unchanged and deliberately thin.** The notebook still reads the gateway bearer token from Key Vault, and the backend forwards that token upstream untouched. The gateway remains the only authority on who may read a change log; the backend does not mint, validate or substitute credentials. This route is therefore *not* behind the Fabric token middleware that guards the rest of `/api` — a Spark notebook has no Fabric token for our application, and inventing one would have meant a second, weaker authority.

**How to know it worked:**

```powershell
$token = "<the gateway bearer token>"
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://asmdb-analytical-backend.azurewebsites.net/api/sync/cdc/<instanceId>?from=0&limit=5" `
  -Headers @{ Authorization = "Bearer $token" }
```

Expect `200`, an `x-asmdb-last-seq` header, and one JSON object per line. Then check the snapshot route the same way and expect `200` with `x-asmdb-snapshot-seq` matching the change log's head — on an empty table that is a body of zero bytes, which is correct rather than a failure. Without the Authorization header, expect `401`.

**The trade-off, stated plainly.** Change-log data now traverses a public endpoint, protected by the same bearer token that protects the gateway itself. The gateway stays private and unreachable from the internet, and the token remains the only credential that can read a change log — but the exposure is a public TLS endpoint rather than a private address, and the backend's App Service plan now carries sync traffic as well as UI traffic. Revisit this if Fabric adds Container Apps to the resource types it integrates DNS for, or if the gateway is moved behind a resource type that Fabric does support.

## 5. Enable the workload once in Fabric

What to do after the first package is uploaded:

1. Tenant enablement: **Fabric Admin Portal** → **Tenant settings** → **Additional workloads** → enable `Org.AsmdbAnalytical`.
2. Capacity enablement: **Fabric Admin Portal** → **Capacity settings** → select the F64+ or F2 developer-mode capacity → enable `Org.AsmdbAnalytical`.

CLI equivalent: no supported Fabric CLI exists for these two workload enablement actions.

How to know it worked: the workload appears as enabled at tenant level and on the capacity.

Failure looks like: enabling capacity before tenant does nothing and reports nothing. If the item does not appear, re-check tenant enablement first.

## 6. Create the Key Vault and grant the workspace identity

The generated notebook reads the CDC gateway credential from Azure Key Vault. Three things must be true before it can: the vault must exist, the workspace identity must be able to read from it, and the notebook must run *as* that identity — which, as step 7 explains, does not happen by default.

### 6.1 Create the vault

In the reference environment the vault already exists. In a new tenant this is a creation step rather than a prerequisite you already meet.

```powershell
az keyvault create `
  --name "<vault-name>" `
  --resource-group "<analytics-resource-group>" `
  --location "swedencentral" `
  --subscription "<subscription-id>" `
  --enable-rbac-authorization true
```

`--enable-rbac-authorization true` is not optional. A vault created in the legacy access-policy mode will ignore the role assignment below, and the failure is a plain 403 that says nothing about the cause.

Then store the gateway token for notebooks:

```powershell
az keyvault secret set --vault-name "<vault-name>" --name "asmdb-gateway-token" --value "<token>"
```

The backend's copy of the same token is intentionally **not** a Key Vault reference in the reference environment. Tenant policy disables public network access on the vault; Fabric reaches it through a managed private endpoint, while App Service cannot. Set `ASMDB_GATEWAY_TOKEN` as an application setting unless/until an App Service private path to the vault is added.

### 6.2 Find the workspace identity

A Fabric workspace identity is an **automatically managed service principal** in Entra, created with an accompanying app registration whose credentials Fabric rotates for you. It is *not* an Azure VM managed identity, and it is not reachable through IMDS — which is why the notebook cannot use `DefaultAzureCredential`.

Find it in **Fabric** → workspace **Settings** → **Workspace identity**. For the reference environment:

| Field | Value |
|---|---|
| Workspace | `<fabric-workspace-name>` |
| Object ID | `<workspace-identity-object-id>` |
| Application ID | `<workspace-identity-app-id>` |

It also appears under **Entra** → **Enterprise applications**, searchable by workspace name.

### 6.3 Grant it read access

Portal: **Key Vault** → **Access control (IAM)** → **Add role assignment** → **Key Vault Secrets User** → *User, group, or service principal* → search by workspace name or object ID.

```powershell
az role assignment create `
  --assignee-object-id "<workspace-identity-object-id>" `
  --assignee-principal-type ServicePrincipal `
  --role "Key Vault Secrets User" `
  --scope "/subscriptions/<subscription-id>/resourceGroups/<analytics-resource-group>/providers/Microsoft.KeyVault/vaults/<vault-name>"
```

Secrets User is read-only, which is all the notebook needs. Do not grant Secrets Officer.

`--assignee-object-id` with an explicit principal type avoids a race: `--assignee` makes the CLI resolve the principal through Graph, which fails intermittently for a service principal created moments earlier.

**How to know it worked:** the assignment appears under the vault's *Role assignments*, and a notebook run under the workspace identity (step 7) reads the secret.

**Failure looks like:** a 403 from Key Vault with no indication of which identity was refused. Check first that the vault is in RBAC mode, then that the notebook is genuinely running as the workspace identity rather than as you.

## 7. Scheduling: the workload's own scheduler, and when not to trust it

This step exists because of a trap that is invisible until it bites, months later.

A Fabric notebook's security context depends entirely on how it was triggered:

| Trigger | Runs as | Usable unattended |
|---|---|---|
| Interactive run | the person who clicked | no |
| **Direct notebook schedule** | **the user who created or last updated the schedule** | **no** |
| Pipeline activity, default authentication | the pipeline's last-modified user | no |
| **Pipeline activity with Workspace Identity** | **the workspace service principal** | **yes** |

Scheduling the notebook directly is the obvious thing to do, and it works — in testing, under your own account. It runs under a **named human identity**, so it keeps working right up until that person's access changes or they leave, at which point the sync stops with a Key Vault permission error that points at nothing.

So the supported production path is a **Data Factory pipeline** containing a **Notebook activity** with **Workspace Identity** selected as the authentication method. Schedule the *pipeline*. Do not schedule the notebook for unattended production. The workload UI exposes Fabric native notebook scheduling as a convenience and states this trade-off beside the control; use it only when a named-human identity is acceptable.

### 7.0 What the workload's own scheduler does, and the contract it obeys

The Notebooks tab schedules the notebook itself, for the convenience case above. It does **not** use the workload SDK's `itemSchedule` client, and that distinction cost a working day to find.

`workloadClient.itemSchedule.*` is for the custom item types a workload declares in its own manifest. A Notebook is a first-party Fabric item, and its schedules live in the Fabric REST API. The two contracts have no fields in common — `jobDefinitionObjectId` does not exist in REST, and there is no `Hourly` type at all. Calls through the SDK client fail in ways that do not name this as the reason.

The workload therefore calls the REST API directly, with a token acquired for the Fabric audience:

```
POST   /v1/workspaces/{ws}/items/{nb}/jobs/RunNotebook/schedules      → 201, synchronous
PATCH  /v1/workspaces/{ws}/items/{nb}/jobs/RunNotebook/schedules/{id}
GET    /v1/workspaces/{ws}/items/{nb}/jobs/RunNotebook/schedules
POST   /v1/workspaces/{ws}/items/{nb}/jobs/RunNotebook/instances      → 202, not 200
GET    /v1/workspaces/{ws}/items/{nb}/jobs/instances                  → run history
```

Four details decide whether a schedule is accepted, and none of them is obvious from the schema:

| Detail | What the API requires |
|---|---|
| `localTimeZoneId` | A **Windows** identifier — `Romance Standard Time`, not `Europe/Paris`. `UTC` is valid in both systems and is the safe fallback |
| `startDateTime`, `endDateTime` | Required in practice, though the schema marks them optional |
| Timestamp format | `YYYY-MM-DDTHH:mm:ss` with **no trailing `Z`**, despite the documentation showing one |
| Hourly cadence | Expressed as `type: "Cron"` with `interval` in **minutes** — an hourly schedule is `interval: 60` |

Run-on-demand returns **202 Accepted**. Treating only 200 as success makes every run report a failure it did not have.

### 7.1 Enable the tenant setting first

**Fabric Admin Portal** → **Tenant settings** → **Developer settings** → **Service principals can call Fabric public APIs** → enable.

This is disabled by default and requires a **Fabric tenant administrator**. Without it the workspace identity cannot authenticate in a notebook activity, so do this before building the pipeline rather than discovering it afterwards.

### 7.2 Build and schedule the pipeline

1. In the workspace, create a **Data pipeline**.
2. Add a **Notebook** activity and point it at the notebook the workload generated.
3. Under **Connection**, set the authentication method to **Workspace Identity**.
4. Add a schedule on the pipeline at the cadence the link needs.

**How to know it worked:** the pipeline run succeeds and the run history attributes it to the workspace identity, not to you.

**Failure looks like:** the run fails at the secret read. Confirm the tenant setting is on, then that the activity's connection really is set to Workspace Identity — it silently defaults to the last-modified user.

---

# Part 2 — Every release or upgrade

## 0. Regenerate the Hub artwork when the interface changes

The Workload Hub renders each `Product.json` image into a fixed slot and **stretches whatever it is given** to fill it. Pointing every field at the square logo is what produced the distorted arc behind the workload title, an oversized crop on the Get started card, and a single giant square in the At a glance carousel.

Only one size is validated at upload — the banner, at **exactly 1920×240** ([publishing requirements §3.1.5](https://learn.microsoft.com/en-us/fabric/extensibility-toolkit/publishing-requirements-workload)). The rest are unvalidated but still rendered into a shape, so they have to be authored deliberately:

| `Product.json` field | Size | Notes |
|---|---|---|
| `productDetail.image` | **1920×240** | Validated. Supply a flat rectangle: the portal clips the arc itself. The title is drawn over the left, and narrow viewports crop the left edge, so keep that area quiet and put nothing legible in the file |
| `productDetail.slideMedia` | 16:9 | Up to 10 entries; images or YouTube/Vimeo embeds |
| `homePage.learningMaterials[].image` | **320×180** | Contained with padding, never edge-to-edge |
| `icon`, `favicon` | ≥ 240×240 square | Rendered anywhere from 16 to 64 px, so supply something larger and let it downsample |

Limits enforced on the `Assets` folder: `.png`/`.jpg`/`.jpeg` only, **1.5 MB per file**, **15 files**, and `Product.json` itself under 50 KB.

Regenerate from the checked-in logo and the README screenshots:

```powershell
python workload/build/gen_hub_assets.py
```

The screenshots are padded to 16:9 rather than cropped — the captures are about 1.65:1, and cropping would remove the interface the slide exists to show. Padding uses each capture's own edge colour, so it is invisible in both the light and dark themes.

**How to know it worked:** `pack.ps1` reports `[PASS] Manifest asset references satisfy Fabric upload limits`, and every generated file prints under the 1.5 MB ceiling.

**Failure looks like:** the packaging preflight names the offending file and its size. Upload-time failures are worse — Fabric validates dimensions when the package is uploaded, not when it is built, so a wrong banner size is discovered after every other step is done.

## 1. Replace release-blocking placeholders
What to do: before producing an uploadable package, replace every placeholder in the manifest files:

- [ ] `workload/manifest/WorkloadManifest.xml` `AADFEApp/AppId`: replace `00000000-0000-0000-0000-000000000000` with the dedicated Entra app id.
- [ ] `workload/manifest/WorkloadManifest.xml` frontend URL: replace `https://REPLACE-ME-asmdb-analytical.example.com` with the verified custom-domain frontend URL.
- [ ] `workload/manifest/Product.json` certification URL: replace `https://REPLACE-ME.example.com/certification`.
- [ ] `workload/manifest/Product.json` privacy URL: replace `https://REPLACE-ME.example.com/privacy`.
- [ ] `workload/manifest/Product.json` terms URL: replace `https://REPLACE-ME.example.com/terms`.

How to know it worked: the packaging preflight reports `[PASS] No placeholder values remain`.

Failure looks like: `pack.ps1` lists every placeholder by file and field and produces no package.

## 2. Build, validate, and package with one command

What to do from the repository root:

```powershell
pwsh .\workload\build\pack.ps1 -Version 1.0.0
```

This command:

1. checks local prerequisites with plain-language fixes;
2. installs frontend dependencies if `node_modules` is missing;
3. builds the frontend production bundle;
4. validates placeholders, workload id duplication, editor path, frontend output, versions, URLs, assets, and video URLs;
5. assembles the Fabric manifest package;
6. emits exactly one `.nupkg` under `workload\build\out\`.

How to know it worked: the checklist ends with `VERDICT: PASS`, and the final line starts with `UPLOAD:` followed by the absolute `.nupkg` path and the upload location.

Failure looks like: the checklist ends with `VERDICT: FAIL`. Fix every `[FAIL]` line; the script reports all known problems at once so you do not have to rerun for one error at a time.

Development-only packaging test:

```powershell
pwsh .\workload\build\pack.ps1 -Version 1.0.0 -AllowPlaceholders
```

Use this only to test package assembly. Do not upload a package built while placeholders remain.

## 3. Upload the package

What to do: upload the file printed on the final `UPLOAD:` line.

Fabric portal path: `admin.fabric.microsoft.com` → **Workload Publishing** → **Upload** → select `workload\build\out\Org.AsmdbAnalytical.<version>.nupkg`.

CLI equivalent: no supported CLI exists for uploading a custom Fabric workload package.

How to know it worked: the Fabric Admin Portal accepts the package without asset, URL, or manifest validation errors.

Failure looks like:

- oversized or wrong-format assets: the portal rejects upload; `pack.ps1` should already catch this;
- unresolved frontend URL: upload or iframe load fails; verify the custom domain and `WorkloadManifest.xml` URL;
- placeholder marketplace links: marketplace submission fails late; `pack.ps1` blocks these unless `-AllowPlaceholders` was used.

## 4. Smoke-check after upload

What to do:

1. Confirm tenant and capacity enablement from Part 1 still apply.
2. In Fabric, create/open an **asmDB Sync Hub** item.
3. Confirm the editor route opens at `/sync-hub` and the panel is not blank.

CLI equivalent: no supported CLI exists for this Fabric UI smoke check.

How to know it worked: the Sync Hub editor opens and authentication starts against the dedicated `asmDB Analytical Capabilities` Entra app.

Failure looks like: blank panel means the frontend route and manifest editor path disagree, or the static host is not serving the SPA fallback for unknown paths. Silent auth failure means the AppId or redirect URI is wrong.
