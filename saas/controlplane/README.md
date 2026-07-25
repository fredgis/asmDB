# asmdb Cloud control plane

Go HTTP service for serving the asmdb Cloud site and provisioning one Azure
Container App per database instance.

## Environment

Required:

| var | meaning |
|---|---|
| `AZURE_SUBSCRIPTION_ID` | target subscription |
| `ASMDB_IMAGE` | full instance container image reference |

Optional/defaulted:

| var | default | meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `AZURE_CLIENT_ID` | unset | user-assigned managed identity client id for Azure |
| `ASMDB_RESOURCE_GROUP` | `<service-resource-group>` | target resource group |
| `ASMDB_ENVIRONMENT` | `asmdb-env` | Container Apps environment |
| `ASMDB_LOCATION` | `swedencentral` | Azure location |
| `ASMDB_STORAGE_ACCOUNT` | unset | enables blob metadata store in container `instances` |
| `ASMDB_ADMIN_KEY` | unset | protects `POST`/`DELETE` when set |

If `ASMDB_ADMIN_KEY` is unset, create/delete are open. This is intentional for
the demo site, but is not appropriate for an untrusted production deployment.

## Endpoints

Base API path: `/api/v1`.

- `POST /databases` with `{ "name": "my-notes", "tier": "free" }`
- `GET /databases`
- `GET /databases/{id}`
- `DELETE /databases/{id}`

Errors use:

```json
{ "error": { "code": "invalid_request", "message": "human", "detail": "optional" } }
```

The site is baked into the image from repository-root `site/` and served at `/`.
CORS is permissive for browser `GET`. `POST`/`DELETE` are allowed only for the
same host in CORS preflight; normal site use is same-origin.

## Provisioning

On create, the service generates a `db_` id, a 32-byte base64url bearer token,
stores only its SHA-256 hash, then creates Container App `db-<id suffix>` in the
configured resource group/environment. The child app receives:

- `ASMDB_TOKEN`
- `ASMDB_NAME=main`
- `ASMDB_DATA=/data`
- `PORT=8080`

Ingress is external on target port 8080. Tier resources and quotas follow the
frozen contract: free `0.25/0.5Gi/0..1`, standard `0.5/1Gi/0..1`, premium
`1.0/2Gi/1..1`. The API returns `201` once Azure accepts the create request; it
does not wait for the app to become running.
