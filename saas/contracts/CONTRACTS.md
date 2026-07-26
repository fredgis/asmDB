# asmdb Cloud — contracts

Current contract for the deployed SaaS control plane, sidecar, and Azure shape.
Every stream codes against it; a stream that needs a change raises it and waits.

Version `2026-07-26.1`.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **instance** | one `asmdb` engine process, one `.dat`/`.wal`/`.cdc` file set, **one table**. There is no notion of "a table inside a database" — see `docs/SAAS.md §0`. |
| **instance id** | `db_` + 24 lowercase base32 chars. Immutable. Also the Container App name suffix. |
| **tier** | `free` · `standard` · `premium`. Selects CPU/memory and whether the app scales to zero. |
| **access token** | opaque bearer string, 43 chars base64url, issued once at creation, stored hashed. |
| **platform token** | per-instance platform bearer token derived as `HMAC-SHA256(ASMDB_PLATFORM_SECRET, instance id)`. It is accepted only by explicitly narrow platform routes: `/v1/stats` and `/v1/prepare-upgrade`. |

---

## 2. Control-plane API

Base: `https://www.asmdb.cloud/api/v1`. All JSON. All errors use §5.

### `POST /databases`

```json
{ "name": "my-notes", "tier": "free" }
```

`name`: 2–40 chars, `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`. `tier`: see above.

**201**
```json
{
  "id": "db_7k2m9x4qp1va8ne03wjr5tzy",
  "name": "my-notes",
  "tier": "free",
  "image": "<registry>.azurecr.io/asmdb-instance:1.5.3",
  "engine": "1.5.3",
  "state": "provisioning",
  "endpoint": "https://www.asmdb.cloud/db/7k2m9x4qp1va8ne03wjr5tzy",
  "token": "<shown once, never again>",
  "created_at": "2026-07-25T19:40:00Z",
  "engineSource": "image",
  "upgradeAvailable": false,
  "availableEngine": "1.5.3",
  "availableImage": "<registry>.azurecr.io/asmdb-instance:1.5.3"
}
```

### `GET /version` → `200 {"engine":"1.5.3","image":"<current instance image>"}`
### `GET /config` → `200 {"tenantId","clientId","scope"}`
### `GET /costs?from=&to=` → estimated costs from Azure Monitor `Replicas`
Entra-authenticated. If absent, `from`/`to` default to the current calendar
month and the window is capped at 31 days. Uses Azure Monitor metric
`Replicas`, namespace `Microsoft.App/containerApps`, `Average` aggregation,
`PT15M` grain. Response:

```json
{
  "basis": "estimated from Azure Monitor Replicas average time at public list rates; not an invoice",
  "from": "2026-07-01T00:00:00Z",
  "to": "2026-07-26T12:00:00Z",
  "totalUsd": 1.2345,
  "counts": { "free": 1, "standard": 2 },
  "databases": [
    {
      "id": "db_...",
      "name": "my-notes",
      "tier": "standard",
      "size": "0.5 vCPU / 1Gi",
      "state": "running",
      "activeHours": 12.25,
      "pausedHours": 600.75,
      "estimatedComputeUsd": 0.5432,
      "windowPredatesInstance": false,
      "metricsUnavailable": false
    }
  ]
}
```

It is an estimate, not an invoice; paused time from zero replicas has zero
compute cost.

### `GET /databases` → `{ "databases": [ <object without token> ] }`
`?include_stats=true` adds the compact `stats` block described below to each database object.
### `GET /databases/{id}` → the object without `token`
### `DELETE /databases/{id}` → **204**, idempotent (deleting a gone instance is 204)

Database objects include:

| field | meaning |
|---|---|
| `image` | image reference recorded at provisioning, including the version tag when known |
| `engine` | engine version actually reported by `/health` if known; otherwise the provisioned image tag, or `"unknown"` |
| `engineSource` | `"instance"` when the value came from sidecar `/health` or `/v1/stats`; `"image"` when it came from the recorded image tag |
| `storageFormat` | storage format reported by the running engine when known |
| `operation` | current or last management operation; see upgrade states below |
| `upgradeAvailable` | true only when both recorded and current images have parseable version tags and the full image references differ |
| `availableEngine` | tag on current `ASMDB_IMAGE`, or `"unknown"` |
| `availableImage` | current instance image when it has a parseable version tag |

### `POST /databases/{id}/exec`

Runs one raw engine command on behalf of the browser terminal and returns the
engine's own output. The browser cannot reach an instance directly — the
platform is a private network with APIM as the only public front door — so the
control plane proxies.

Authenticated with the **instance** access token, not an Entra token: this is
the one control-plane route that speaks the data plane's credential.

```json
{ "command": "SELECT *" }
```

**200**
```json
{ "output": ["+------+---------+", "| id   | tag     |", "…"], "ok": true }
```

`ok` is `false` when the engine answered `[ERR]`. That is still **200** — an
engine error is a normal thing to print in a terminal, not a transport failure.
Reserve status codes for transport: `401` bad token, `404` no such instance,
`400` malformed body, `502` instance unreachable or malformed, `504`
`instance_starting` when Azure returns its stopped-app HTML page for the whole
cold-start retry budget.

The proxy retries Azure cold-start HTML for about 45 s and never returns that
HTML body to clients. The browser can also call `POST /databases/{id}/wake` to
start activation before the first terminal command. `instance_starting` is a
normal retryable state and is distinct from `stopped` and from a genuine
upstream failure; the console renders it as "waking" rather than "broken".

### `POST /databases/{id}/wake`

Entra-authenticated. Triggers activation with an internal `/health` request and
returns promptly with the current Azure state:

```json
{ "id": "db_...", "state": "stopped", "error": "" }
```

### `GET /databases/{id}/stats`

Entra-authenticated. Calls the instance's internal `/v1/stats` with the
per-instance platform token. It does not wake stopped instances.

```json
{ "available": true, "stats": { "...": "sidecar payload" } }
```

or

```json
{ "available": false, "reason": "stopped|instance_starting|unavailable|timeout|platform_token_unconfigured" }
```

`instance_starting` means the platform returned the Azure stopped-app HTML page
instead of a sidecar JSON payload. It is distinct from `stopped` (known zero
replicas) and `unavailable` (broken, rejected, or malformed response).

### `POST /databases/{id}/rotate-token`

Entra-authenticated. Generates a new instance token, updates the child Container
App's `ASMDB_TOKEN`, and returns the new token once:

```json
{ "token": "<shown once>", "warning": "Token rotation restarts the instance and briefly interrupts active connections." }
```

Instance Container App changes are **stop-then-start**, not rolling. The
outgoing replica is stopped first so the single-writer engine releases its file
lock, the new revision is started, and readiness is confirmed before success is
reported. If the replacement does not become healthy, the previous app spec and
metadata are restored and the **old token remains the working token**.

### `POST /databases/{id}/upgrade`

Entra-authenticated. Refused with `409 no_upgrade` when the instance already
uses the current engine. If the instance has reported its actual engine version,
that value wins over the recorded image tag for upgrade decisions.

**202**

```json
{
  "database": { "...": "...", "operation": {
    "type": "upgrade",
    "state": "preparing_backup",
    "started_at": "2026-07-26T13:40:00Z",
    "updated_at": "2026-07-26T13:40:00Z"
  }},
  "operation": {
    "type": "upgrade",
    "state": "preparing_backup",
    "started_at": "2026-07-26T13:40:00Z",
    "updated_at": "2026-07-26T13:40:00Z"
  },
  "warning": "Upgrade runs asynchronously, restarts the instance, and briefly interrupts active connections."
}
```

The console polls `GET /databases/{id}` and reads `database.operation`.

The required operation is:

1. Call the sidecar's narrow `POST /v1/prepare-upgrade` route with the
   per-instance platform token. Anything other than success aborts the upgrade
   before the Container App is touched.
2. Apply the new image with the same stop-then-start sequence used by token
   rotation. This is not zero-downtime: the instance restarts and active
   connections are interrupted.
3. Record the new image only after the replacement revision is healthy. If the
   replacement does not become healthy, roll back to the previous app spec and
   leave the recorded image unchanged.

A stopped instance is deliberately started to prepare the upgrade rather than
silently skipping the pre-upgrade snapshot.

Upgrade operation states:

| state | meaning |
|---|---|
| `preparing_backup` | sidecar `/v1/prepare-upgrade` is running; failure aborts before any app/image change |
| `stopping` | outgoing revision is being stopped so it releases the database file lock |
| `starting` | replacement revision has been applied and is being started |
| `verifying_health` | waiting for the replacement revision to become healthy |
| `done` | replacement is healthy and metadata has been reconciled |
| `failed` | operation stopped; `error` explains whether backup failed before changes or start failed and rollback was attempted |

Only one active operation may run for an instance. A second upgrade, or an
upgrade while token rotation is in progress, returns `409 operation_in_progress`.
Active operations expire after 30 minutes. Expiry is deliberate: after a control
plane restart the in-process worker is gone, so the next read marks stale state
`failed` instead of stranding the console forever.

### Instance states

`provisioning` → `running` → `stopped` → `deleting` → *(gone)*.
`failed` is terminal and carries `error`.

---

## 2b. Who may call the control plane

Two credentials, never interchangeable.

| Routes | Credential |
|---|---|
| management routes under `/databases`, plus `/costs` | **Microsoft Entra ID** access token |
| `POST /databases/{id}/exec` | the **instance** access token |
| `GET /healthz`, `GET /version`, `GET /config`, the static site | none |

Management is gated on Entra sign-in. The token must be a **v2 access token**
for `api://<client-id>/console.access`, verified against the tenant's JWKS —
signature, issuer, audience and expiry — and its `groups` claim must contain the
object id of the security group **`ASMDB_ADMIN`**. A valid token from a user
outside that group is **403**, not 401: the caller is authenticated, just not
allowed.

An ID token is not accepted in place of an access token, and a payload is never
trusted without verifying the signature.

`GET /config` returns `{"tenantId","clientId","scope"}` so the browser can
configure itself. Those three are public values in any SPA. The flow is
authorization-code with PKCE, so **there is no client secret anywhere** — not in
the image, not in the repository, not in an app setting.

Configuration arrives as `ASMDB_ENTRA_TENANT_ID`, `ASMDB_ENTRA_CLIENT_ID` and
`ASMDB_ENTRA_GROUP_ID`. If they are absent the management API fails closed.

---

## 3. Data-plane API (the sidecar, one per instance)

Base: the instance `endpoint`. Except for `/health`, routes require the instance access token in the `Authorization` header. `/v1/stats` and `/v1/prepare-upgrade` also accept the platform token.

| Route | Body | Success |
|---|---|---|
| `GET /health` | — | `200 {"status":"ok","engine":"1.5.3","storageFormat":"<n>","rows":<n>}` — **no auth** |
| `GET /v1/rows?limit=&offset=` | — | `200 {"rows":[Row],"count":<n>,"hasMore":<bool>,"nextOffset":<n>}` |
| `GET /v1/rows/{id}` | — | `200 {"row":Row}` / `404` |
| `POST /v1/rows` | `Row` without timestamps | `201 {"row":Row}` |
| `PUT /v1/rows/{id}` | `{value,tag,content}` | `200 {"row":Row}` |
| `DELETE /v1/rows/{id}` | — | `204` |
| `GET /v1/count` | — | `200 {"count":<n>}` |
| `GET /v1/find?q=&limit=&offset=` | — | same shape as `/v1/rows` |
| `GET /v1/range?lo=&hi=&limit=&offset=` | — | same shape as `/v1/rows` |
| `POST /v1/verify` | — | `200 {"ok":<bool>,"detail":"<engine output>"}` |
| `POST /v1/exec` | `{"command":"<one line>"}` | `200 {"output":[<lines>],"ok":<bool>}` |
| `GET /v1/stats` | — | `200` live stats payload; instance token or platform token |
| `POST /v1/prepare-upgrade` | ignored | `200 {"ok":true,"backup":{...},"output":[...]}` or `200 {"ok":false,"error":"backup_failed","detail":"...","output":[...]}`; instance token or platform token |
| `POST /mcp` | MCP streamable-HTTP | the MCP session |

`limit` default 100, max 1000. `offset` default 0.

`/health` reports the engine version and storage format read from the engine's
own `VERSION` output, not from the image tag or a sidecar constant. If the
engine output cannot be parsed, those fields are `"unknown"`.

`/v1/stats` is read-only introspection. `/v1/prepare-upgrade` is the only
non-read route that accepts the platform token. It is safe for the platform
token only because no caller-supplied value reaches the engine: the sidecar
chooses the backup path and runs exactly one operation, a pre-upgrade `BACKUP`
to a durable file. It must never become a generic command runner. The platform
token is not accepted for CRUD, `/v1/exec`, `/v1/verify`, or `/mcp`.

Prepare-upgrade success:

```json
{
  "ok": true,
  "backup": {
    "path": "/data/main.pre-upgrade.20260726T130000.000000000Z.bak",
    "apparentBytes": "1073741824",
    "allocatedBytes": "1073741824"
  },
  "output": ["[ OK ] backup"]
}
```

Prepare-upgrade backup failure is still HTTP 200 so the caller can distinguish
an engine-level backup refusal from transport/auth failure:

```json
{
  "ok": false,
  "error": "backup_failed",
  "detail": "<engine detail>",
  "output": ["[ERR] ..."]
}
```

The control plane aborts upgrade on any non-2xx response, malformed response,
or `{"ok":false}`.

Stats shape (premium/large example):

```json
{
  "rows": "1",
  "capacity": "4194304",
  "engine": "1.5.3",
  "storageFormat": "2",
  "uptimeSeconds": 123,
  "storage": {
    "dataBytes": "1073741824",
    "dataAllocatedBytes": "1073741824",
    "dataApparentBytes": "1073741824",
    "walBytes": "0",
    "walAllocatedBytes": "0",
    "walApparentBytes": "0",
    "cdcBytes": "0",
    "cdcAllocatedBytes": "0",
    "cdcApparentBytes": "0"
  },
  "memory": {
    "usedBytes": "123",
    "limitBytes": "456",
    "fileBytes": "0",
    "inactiveFileBytes": "0",
    "reclaimableBytes": "0",
    "workingSetBytes": "123",
    "events": {},
    "pressure": {}
  },
  "cpu": { "usageUsec": "1234", "limitCores": 0.5 }
}
```

`workingSetBytes` is the container cgroup view and includes file-backed page
cache from the engine's copy-on-write `.dat` mapping. Treat it as reserved /
reclaimable cache, not private engine consumption; `fileBytes`,
`inactiveFileBytes` and `reclaimableBytes` are present so the console can show
reserved versus actually used.

### `/v1/exec` — the terminal's route

Everything else here parses the engine's machine format. `/v1/exec` is the one
route that returns what a human would see, so it switches the engine to
`FORMAT TABLE`, runs the command, and switches back to `FORMAT TSV` — all three
under a single hold of the engine lock, and the restore runs even when the
command failed. Leaving the engine in TABLE mode would make every later reply on
every other route parse as TSV against a table: silent corruption of the whole
data API.

Refused before reaching the engine:

- a command containing `CR` or `LF` — one request is one command. Two commands
  produce two `[ OK ]` terminators and desynchronise the reader for every
  request that follows.
- `EXIT` and `QUIT` — they stop the engine process. A terminal session is not an
  engine session; there is nothing to exit.
- anything over 511 bytes.

Everything else the engine accepts is allowed. It is the customer's own
database.

### Row

```json
{
  "id": "1001",
  "value": "-5",
  "tag": "project",
  "content": "free text",
  "created": "1785001293764",
  "updated": "1785001293764"
}
```

**Every numeric field is a decimal STRING.** `id` is u64, `value` is i64,
timestamps are unix-epoch-milliseconds u64 — none survive a JavaScript number.
`tag` ≤ **39 bytes**, `content` ≤ **175 bytes** (the engine reserves the last
byte of each column for its terminator and **refuses** longer input).

---

## 4. Sidecar ↔ engine protocol

The sidecar owns exactly one child process: `asmdb <db> ` (writer). It **must**:

1. Send `FORMAT TSV` as the very first command. Never parse the ASCII table.
2. Read rows as `R\t<id>\t<value>\t<created>\t<updated>\t<tag>\t<content>` and
   unescape exactly four sequences in `tag`/`content`: `\\` `\t` `\n` `\r`.
   Every other byte passes through — **UTF-8 is preserved**.
3. Bound every listing with `PAGE <limit> <offset>` before the command.
4. Treat a line starting `[ OK ]` as success and `[ERR]` as failure; the result
   set of a listing ends at the first status line.
5. Serialise commands — one in flight at a time, with a short default timeout;
   `BENCH`, `BACKUP`, `RESTORE`, `VERIFY`, and `TRUNCATE` get a long timeout.
6. Restart the engine if it exits, wait/back off for the file lock, and fail
   queued commands rather than hang.

Engine facts the sidecar must not fight:

- **One writer.** Reads may use `asmdb <db> --reader` (any number, no lock).
- A transaction touches at most **4096 distinct rows**.
- `FIND` and `RANGE` are **full scans** — always bound them. The ~900 ms figure
  quoted elsewhere is a local workstation measurement, not a hosted-tier SLA.

---

## 5. Error envelope

Every non-2xx from either plane:

```json
{ "error": { "code": "<machine_code>", "message": "<human>", "detail": "<optional>" } }
```

| code | HTTP |
|---|---|
| `unauthorized` | 401 |
| `not_found` | 404 |
| `already_exists` | 409 |
| `invalid_request` | 400 |
| `field_too_long` | 400 |
| `quota_exceeded` | 429 |
| `engine_error` | 502 |
| `internal` | 500 |
| `instance_starting` | 504 |
| `no_upgrade` | 409 |
| `operation_in_progress` | 409 |
| `gateway_timeout` | 504 |

---

## 6. Tiers

Capabilities are real. Prices are derived in [`docs/COST.md`](../../docs/COST.md)
from Azure list rates, at **15 % margin on run**.

| tier/capability | price | CPU | memory | scale-to-zero | max instances | max rows |
|---|---|---|---|---|---|---:|
| `free` | $0 | 0.25 | 0.5Gi | yes (idle 5 min) | 3 | 393 216 |
| `standard` | $15/mo | 0.5 | 1Gi | yes (idle 30 min) | 20 | 1 572 864 |
| `premium` | $49/mo | 1.0 | 2Gi | no (always warm) | 10 | 3 145 728 |
| Microsoft Fabric Workload | planned for GA, premium capability | — | — | — | — | — |
| automated backups | planned for GA, standard and premium capability | — | — | — | — | — |

> **These limits are global, not per account.** The `instance` record carries no
> tenant, owner or account, so quotas are counted across the whole deployment
> and every member of the administrator group can see and manage every database.
> The service is a single-organisation tool until an owner is recorded per
> instance, quotas are counted per tenant, and reads are filtered by ownership.

The sizes are not free choices: Container Apps Consumption accepts only fixed
vCPU/memory pairs at a 1:2 ratio, and **0.25 / 0.5Gi is the floor** — there is
nothing smaller to sell. Verified against the API, which refuses anything else:
`0.1 / 0.2Gi` and `0.25 / 0.25Gi` are both rejected with
`ContainerAppInvalidResourceTotal`. The portal's resource fields advertise a
minimum of 0.1, but that is the input control's bound, not the platform's — such
a value passes field validation and then fails on save.

**Max rows is set by memory, not by licensing.** The engine's slot table is
mapped copy-on-write, so local sparse filesystems only materialise touched
pages, but the table still has a real tier size: 2^22 slots is exactly 1 GiB.
In the hosted service, cgroup working set includes reclaimable file-backed cache
from that mapping. Each tier gets the largest power-of-two table its memory can
carry, and the published maximum is the row count the engine actually refuses
to exceed — there is no advertised ceiling that inserts fail before reaching. The tier
picks the table at creation via `ASMDB_CAPACITY`; the size is then recorded in
the database header, which wins on every later open, so the variable can never
reshape an existing database. Raising a tier's ceiling would mean buying more
memory, and since memory only sells paired with CPU, that doubles the bill —
which is why the ceiling moves with the tier rather than with the price list.

The three-instance cap on `free` is a **pricing control**, not a technical
limit: a free database still costs about $1.03/month to run and is funded by the
paying tiers.

The `standard` and `premium` caps are the opposite — they are **capacity
controls**, and they are measured, not chosen for effect. Every instance keeps
its own file on the shared Premium Files NFS volume, and Azure Files NFS does
not honour sparseness, so a database occupies its whole table size on disk from
the day it is created. The provisioned share is **100 GiB**, which is roughly
800 `free`, 200 `standard` or 100 `premium` databases **in total, across every
deployment**. A `premium` cap of 100 would let one customer consume the
entire platform, so it is 10. Raising any of these caps means growing the share
first; the cap is a consequence of provisioning, not an independent dial.

Every tier gets the same engine and the same durability. Tiers buy **latency,
headroom and capacity**, not features; the row ceiling follows the memory that
the tier can give to the resident slot table.

No per-tier throughput number is part of this contract. Repository benchmark
figures are measured on one workstation core, not through the hosted REST/MCP
path. Hosted throughput depends on the tier's vCPU allocation (0.25 / 0.5 /
1.0), gateway overhead, request shape and whether the app is cold. `free` and
`standard` scale to zero and the first request after idling waits for a
container start; `premium` stays warm.

`maxReplicas` is **1 on every tier and is not negotiable**. The engine is a
single-writer process that takes an exclusive lock on its files; a second
replica is not extra capacity, it is a second database that cannot start.
Tiers scale up, never out.

### Storage

Each instance mounts a durable volume at `/data`, and `ASMDB_DATA` points at
that mount. A Container App's own filesystem is discarded on every restart and
on every scale to zero, so an instance without a volume loses the customer's
database the first time it goes idle — the control plane refuses to start if
the volume is not configured.

| | |
|---|---|
| Backing store | Azure Files **NFS 4.1**, one share for the whole platform |
| Isolation | volume mount `subPath` = the instance id, so each database owns a directory |
| Auth | none to carry: NFS is reachable only from the private VNet, so no account key exists to leak |
| Mount path | `/data` — must equal `ASMDB_DATA`, asserted in `provisioner_test.go` |
| Sparse files | not honoured on the live share; each database occupies its full tier table: about 128 MiB (`free`), 512 MiB (`standard`) or 1 GiB (`premium`) |

SMB was rejected: Container Apps' SMB mount needs a storage account key, and
the accounts here run with `allowSharedKeyAccess: false`.

---

## 7. Azure resource names

Deterministic, so the deployment is idempotent.

| Resource | Name |
|---|---|
| Resource group | `<service-resource-group>` (exists, `swedencentral`) |
| Container registry | `asmdbacr<suffix>` |
| Container Apps env | `asmdb-env` |
| Control plane app | `asmdb-cp` |
| Instance app | `db-<instance-id-without-prefix>` |
| Log Analytics | `asmdb-logs` |
| Managed identity | `asmdb-mi` (AcrPull + Contributor on the RG) |
| Blob account (control-plane state) | `asmdbst<suffix>` |
| File account (instance data, Premium NFS) | `asmdbfs<suffix>` |
| Environment storage | `asmdb-data` → share `instances` |

`<suffix>` = first 8 chars of a hash of the subscription+RG, so re-running the
deployment finds the same registry instead of creating a second one.

---

## 8. Ownership

| Path | Owner |
|---|---|
| `saas/contracts/` | orchestrator only |
| `saas/sidecar/` | Agent A |
| `saas/controlplane/` | Agent C |
| `saas/infra/` | Agent I |
| `site/` | orchestrator only |
| `src/`, `tests/`, `docs/`, `mcp/`, `README.md` | orchestrator only — **do not touch** |

