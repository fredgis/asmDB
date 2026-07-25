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

### Instance states

`provisioning` → `running` → `stopped` → `deleting` → *(gone)*.
`failed` is terminal and carries `error`.

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
| `POST /mcp` | MCP streamable-HTTP | the MCP session |

`limit` default 100, max 1000. `offset` default 0.

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
