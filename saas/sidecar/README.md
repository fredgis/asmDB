# asmdb Cloud sidecar

Go HTTP sidecar for one `asmdb` writer process. v1 deliberately uses the single writer process for reads and writes: it is simpler, preserves engine ordering, and the sidecar serialises commands anyway.

## Local run

```powershell
$env:ASMDB_BIN="C:\path\to\asmdb.exe"
$env:ASMDB_DATA="C:\data\asmdb"
$env:ASMDB_NAME="main"
$env:ASMDB_TOKEN="dev-token"
go run .
```

`GET /health` is unauthenticated. All other routes require `Authorization: Bearer <ASMDB_TOKEN>`.

## Environment

| var | default | meaning |
|---|---:|---|
| `ASMDB_BIN` | `/app/asmdb` | Engine executable path. |
| `ASMDB_DATA` | `/data` | Directory for `.dat`, `.wal`, and `.cdc` files. |
| `ASMDB_NAME` | `main` | Database base name. |
| `ASMDB_TOKEN` | required | Bearer token; startup fails if empty. |
| `PORT` | `8080` | HTTP listen port. |

## Container build

The Docker build context must be the repository root so the engine stage can copy `src/`:

```powershell
az acr build --registry <acr-name> --image asmdb-sidecar:latest --file saas/sidecar/Dockerfile .
```

The final image is Alpine for practical shell/debug access while still small. It runs as a non-root user and stores data under `/data`.
