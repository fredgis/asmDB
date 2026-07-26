# asmdb Cloud sidecar

Go HTTP sidecar for one `asmdb` writer process. v1 deliberately uses the single writer process for reads and writes: it is simpler, preserves engine ordering, and the sidecar serialises commands anyway.

## Local run

```powershell
$env:ASMDB_BIN="C:\path\to\asmdb.exe"
$env:ASMDB_DATA="C:\data\asmdb"
$env:ASMDB_NAME="main"
$env:ASMDB_TOKEN="dev-token"
$env:ASMDB_PLATFORM_TOKEN="dev-platform-token"
go run .
```

`GET /health` is unauthenticated. Data-plane routes require the instance access token. `/v1/stats` and `/v1/prepare-upgrade` also accept the narrower `ASMDB_PLATFORM_TOKEN`; prepare-upgrade is limited to one sidecar-chosen backup command.

Hosted instances are reached through the control-plane prefix
`https://www.asmdb.cloud/db/<instance>/v1/...` and MCP at
`https://www.asmdb.cloud/db/<instance>/mcp`.

## Environment

| var | default | meaning |
|---|---:|---|
| `ASMDB_BIN` | `/app/asmdb` | Engine executable path. |
| `ASMDB_DATA` | `/data` | Directory for `.dat`, `.wal`, and `.cdc` files. |
| `ASMDB_NAME` | `main` | Database base name. |
| `ASMDB_TOKEN` | required | instance bearer token; startup fails if empty. |
| `ASMDB_PLATFORM_TOKEN` | unset | optional platform token for `/v1/stats` and the narrow `/v1/prepare-upgrade` backup hook. |
| `PORT` | `8080` | HTTP listen port. |

## Routes

- `GET /health` -> `{"status":"ok","engine":"<engine version>","storageFormat":"<format>","rows":n}` without auth.
- `GET /v1/rows?limit=&offset=`
- `GET /v1/rows/{id}`
- `POST /v1/rows`
- `PUT /v1/rows/{id}`
- `DELETE /v1/rows/{id}`
- `GET /v1/count`
- `GET /v1/find?q=&limit=&offset=`
- `GET /v1/range?lo=&hi=&limit=&offset=`
- `POST /v1/verify`
- `POST /v1/exec`
- `GET /v1/stats`
- `POST /v1/prepare-upgrade`
- `POST /mcp`

`/v1/exec` runs one terminal command under the engine lock. `BENCH`, `BACKUP`, `RESTORE`, `VERIFY`, and `TRUNCATE` get the long command timeout; other commands use the short timeout. If the engine exits, the sidecar restarts it and backs off while waiting for the exclusive file lock.

`/health` and `/v1/stats` report the engine version and storage format read from the engine's `VERSION` command, not a sidecar constant. `/v1/stats` also reports live rows/capacity, uptime, CPU, cgroup memory, and storage. Storage includes both apparent and allocated byte counts for `.dat`, `.wal`, and `.cdc`; memory includes file, inactive-file, reclaimable, and working-set fields plus cgroup events/pressure when available.

`/v1/prepare-upgrade` takes no request body. It accepts the instance token or platform token, runs exactly `BACKUP <sidecar-chosen path>` under the engine lock, and returns `{"ok":true,"backup":{"path":"...","apparentBytes":"...","allocatedBytes":"..."},"output":[...]}`. No caller-supplied value reaches the engine command. Engine backup failures return `{"ok":false,"error":"backup_failed","detail":"...","output":[...]}` so the control plane can abort the upgrade.

## Container build

The Docker build context must be the repository root so the engine stage can copy `src/`:

```powershell
az acr build --registry <acr-name> --image asmdb-instance:<version> --image asmdb-instance:latest --file saas/sidecar/Dockerfile .
```

The final image is Alpine for practical shell/debug access while still small. It runs as a non-root user and stores data under `/data`.
