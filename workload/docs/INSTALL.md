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
| Application ID URI | `https://workload.asmdb.cloud/fe/be/Org.AsmdbAnalytical/1` | same |
| Exposed scope | `FabricWorkloadControl`, Power BI `871c010f-5e61-4fb1-83ac-98610a7e9110` preauthorised | same |
| Federated credential | subject `<backend-mi-principal-id>` (backend managed identity), audience `api://AzureADTokenExchange` | `…/federatedIdentityCredentials` |
| Key Vault | `<key-vault-name>`, **RBAC authorisation enabled** | `az keyvault show` |
| Key Vault grant | workspace identity `<fabric-workspace-name>` / `<workspace-identity-object-id>` → **Key Vault Secrets User** | `az role assignment list --scope <vault>` |
| Backend | `https://asmdb-analytical-backend.azurewebsites.net` | `/health` returns `{"status":"ok","version":"0.1.0"}` |
| Frontend | `https://fe.asmdb.cloud` | `/`, `/sync-hub` and `/close` all return 200 over HTTPS |

Two things are deliberately **not** deployed:

- **The CDC gateway.** It reads a read-only mount of the Azure Files share that asmDB Cloud instances write to, so it belongs in `<service-resource-group>` alongside the service, not in the analytics group.
- **Real support links.** Three still read `REPLACE-ME`, and the three GitHub links resolve only while the repository is private. Neither blocks a tenant-internal install; both block Workload Hub submission.

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
App ID URI        https://workload.asmdb.cloud/fe/be/Org.AsmdbAnalytical/1
```

`fe.workload.asmdb.cloud` looks reasonable and is **rejected**, because two labels sit between the host and the verified domain. The upload fails with:

```text
Frontend Uri domain workload.asmdb.cloud is not in the tenant domains list
```

That message names a host nobody configured — `workload.asmdb.cloud` is simply what remains after Fabric removes `fe`. If you see a domain you never typed, this is why. The packaging preflight now enforces the same rule, so the failure happens locally rather than at upload.

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
https://workload.asmdb.cloud/fe/be/Org.AsmdbAnalytical/1
```

CLI equivalent:

```powershell
az ad app update `
  --id "<app-id>" `
  --identifier-uris "https://workload.asmdb.cloud/fe/be/Org.AsmdbAnalytical/1"
```

How to know it worked: the Application ID URI begins with `https://workload.asmdb.cloud/` and contains the current workload id.

Failure looks like: an `api://...` URI or an Azure-assigned/default domain remains. That does not satisfy the documented Fabric publishing requirement.

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

No Key Vault exists in the subscription yet, so this is a creation step rather than a prerequisite you already meet.

```powershell
az keyvault create `
  --name "<vault-name>" `
  --resource-group "<analytics-resource-group>" `
  --location "swedencentral" `
  --subscription "<subscription-id>" `
  --enable-rbac-authorization true
```

`--enable-rbac-authorization true` is not optional. A vault created in the legacy access-policy mode will ignore the role assignment below, and the failure is a plain 403 that says nothing about the cause.

Then store the gateway token:

```powershell
az keyvault secret set --vault-name "<vault-name>" --name "asmdb-gateway-token" --value "<token>"
```

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

## 7. Schedule syncs through a pipeline, not the notebook

This step exists because of a trap that is invisible until it bites, months later.

A Fabric notebook's security context depends entirely on how it was triggered:

| Trigger | Runs as | Usable unattended |
|---|---|---|
| Interactive run | the person who clicked | no |
| **Direct notebook schedule** | **the user who created or last updated the schedule** | **no** |
| Pipeline activity, default authentication | the pipeline's last-modified user | no |
| **Pipeline activity with Workspace Identity** | **the workspace service principal** | **yes** |

Scheduling the notebook directly is the obvious thing to do, and it works — in testing, under your own account. It runs under a **named human identity**, so it keeps working right up until that person's access changes or they leave, at which point the sync stops with a Key Vault permission error that points at nothing.

So the supported production path is a **Data Factory pipeline** containing a **Notebook activity** with **Workspace Identity** selected as the authentication method. Schedule the *pipeline*. Do not schedule the notebook.

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
