# asmdb Cloud — frozen contracts

Wave 0 output. **Only the orchestrator changes this file.** Every stream codes
against it; a stream that needs a change raises it and waits.

Version `2026-07-25.1`.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **instance** | one `asmdb` engine process, one `.dat`/`.wal`/`.cdc` file set, **one table**. There is no notion of "a table inside a database" — see `docs/SAAS.md §0`. |
| **instance id** | `db_` + 24 lowercase base32 chars. Immutable. Also the Container App name suffix. |
| **tier** | `free` · `standard` · `premium`. Selects CPU/memory and whether the app scales to zero. |
| **access token** | opaque bearer string, 43 chars base64url, issued once at creation, stored hashed. |

---

## 2. Control-plane API

Base: `https://<controlplane-host>/api/v1`. All JSON. All errors use §5.

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
  "state": "provisioning",
  "endpoint": "https://db-7k2m9x4qp1va8ne03wjr5tzy.<env-domain>",
  "token": "<shown once, never again>",
  "created_at": "2026-07-25T19:40:00Z"
}
```

### `GET /databases` → `{ "databases": [ <object without token> ] }`
### `GET /databases/{id}` → the object without `token`
### `DELETE /databases/{id}` → **204**, idempotent (deleting a gone instance is 204)

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
`400` malformed body, `502` instance unreachable, `504` instance timed out.

The client timeout must exceed 20 s: `free` and `standard` scale to zero, so
the first command after an idle period waits for a cold start.

### Instance states

`provisioning` → `running` → `stopped` → `deleting` → *(gone)*.
`failed` is terminal and carries `error`.

---

## 2b. Who may call the control plane

Two credentials, never interchangeable.

| Routes | Credential |
|---|---|
| `POST`/`GET`/`DELETE /databases` | **Microsoft Entra ID** access token |
| `POST /databases/{id}/exec` | the **instance** access token |
| `GET /healthz`, `GET /config`, the static site | none |

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

Base: the instance `endpoint`. **Every route requires** `Authorization: Bearer <token>`.

| Route | Body | Success |
|---|---|---|
| `GET /health` | — | `200 {"status":"ok","engine":"1.5.0","rows":<n>}` — **no auth** |
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
| `POST /mcp` | MCP streamable-HTTP | the MCP session |

`limit` default 100, max 1000. `offset` default 0.

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
5. Serialise commands — one in flight at a time, with a 30 s timeout.
6. Restart the engine if it exits, and fail all queued commands rather than hang.

Engine facts the sidecar must not fight:

- **One writer.** Reads may use `asmdb <db> --reader` (any number, no lock).
- A transaction touches at most **4096 distinct rows**.
- `FIND` and `RANGE` are **full scans** (~900 ms) — always bound them.

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

---

## 6. Tiers

Capabilities are real. **Prices are not set** — the site says "pricing at GA".

| tier | CPU | memory | scale-to-zero | max instances / account |
|---|---|---|---|---|
| `free` | 0.25 | 0.5Gi | yes (idle 5 min) | 3 |
| `standard` | 0.5 | 1Gi | yes (idle 30 min) | 20 |
| `premium` | 1.0 | 2Gi | no (always warm) | 100 |

Every tier gets the same engine, the same 4 194 304-row ceiling, the same
durability. Tiers buy **latency and headroom**, not features.

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
