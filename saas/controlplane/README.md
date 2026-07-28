# asmdb Cloud control plane

Go HTTP service for serving the asmdb Cloud site and provisioning one Azure
Container App per database instance.

## Environment

Required:

| var | meaning |
|---|---|
| `AZURE_SUBSCRIPTION_ID` | target subscription |
| `ASMDB_IMAGE` | full instance container image reference, normally tagged with the engine version |
| `ASMDB_ENTRA_TENANT_ID` | tenant used to validate console access tokens |
| `ASMDB_ENTRA_CLIENT_ID` | application id; accepted audience is `api://<client-id>` |
| `ASMDB_ENTRA_GROUP_ID` | `ASMDB_ADMIN` group object id |

Startup fails if any required variable is empty.

Optional/defaulted:

| var | default | meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `AZURE_CLIENT_ID` | unset | user-assigned managed identity client id for Azure |
| `ASMDB_RESOURCE_GROUP` | `<service-resource-group>` | target resource group |
| `ASMDB_ENVIRONMENT` | `asmdb-env` | Container Apps environment |
| `ASMDB_LOCATION` | `swedencentral` | Azure location |
| `ASMDB_STORAGE_ACCOUNT` | unset | enables blob metadata store in container `instances` |
| `ASMDB_PUBLIC_BASE` | internal app FQDN | public data-plane base, e.g. `https://www.asmdb.cloud/db` |
| `ASMDB_ENV_STORAGE` | `asmdb-data` | Container Apps environment storage mount name |
| `ASMDB_PLATFORM_SECRET` | unset | derives per-instance `/v1/stats` and `/v1/prepare-upgrade` platform tokens; stats, upgrades, and token rotation degrade or fail if missing |
| `ASMDB_SITE_DIR` | `/app/site` | static site directory |
| `ASMDB_BACKUP_TIMEOUT` | `30m` | positive Go duration for pre-upgrade backup |

Management routes fail closed unless a verified Entra access token has the
`ASMDB_ADMIN` group claim. The instance token is separate and is used only for
the data plane and `/exec` proxy. Missing or invalid Entra tokens return 401;
valid tokens outside the group return 403.

## Endpoints

Base API path: `/api/v1`.

- `GET /healthz` outside the API base
- `POST /databases` with `{ "name": "my-notes", "tier": "free" }`
- `GET /databases`
- `GET /databases?include_stats=true`
- `GET /databases/{id}`
- `DELETE /databases/{id}`
- `POST /databases/{id}/exec`
- `POST /databases/{id}/rotate-token`
- `POST /databases/{id}/rotate-token/commit`
- `POST /databases/{id}/upgrade`
- `GET /databases/{id}/stats`
- `POST /databases/{id}/wake`
- `GET /version`
- `GET /config`
- `GET /costs?from=&to=`

Errors use:

```json
{ "error": { "code": "invalid_request", "message": "human", "detail": "optional" } }
```

The site is baked into the image from repository-root `site/` and served at `/`.
CORS is permissive for browser `GET`. `POST`/`DELETE` are allowed only for the
same host in CORS preflight; normal site use is same-origin.

Database responses include the recorded `image`, `engine`, `upgradeAvailable`,
`availableEngine`, `availableImage`, `engineSource`, `storageFormat`, and
`operation` fields. `engine` comes from the running instance's `/health` or
`/v1/stats` response when already known, otherwise from the recorded image tag;
unparseable tags are reported as `unknown`, not an empty string.
`GET /version` exposes the current platform engine/image from the configured
`ASMDB_IMAGE`.

Upgrade is asynchronous: `POST /databases/{id}/upgrade` returns 202 with an
`operation`, and the console polls the database object. States are
`preparing_backup`, `stopping`, `starting`, `verifying_health`, `done`, and
`failed`. Active operations expire after 30 minutes so a control-plane restart
does not strand a database forever. Upgrade is refused when already current,
pre-upgrade preparation must succeed first, the instance restarts, and the
recorded image changes only after the replacement is healthy.

## Provisioning

On create, the service generates a `db_` id, a 32-byte base64url bearer token,
stores only its SHA-256 hash, records the full `ASMDB_IMAGE` reference and
engine version tag, then creates Container App `db-<id suffix>` in the
configured resource group/environment. The child app receives:

- `ASMDB_TOKEN`
- `ASMDB_PLATFORM_TOKEN`
- `ASMDB_NAME=main`
- `ASMDB_DATA=/data`
- `PORT=8080`
- `ASMDB_CAPACITY=small|medium|large`

Token rotation is two-phase. `POST /rotate-token` stores an encrypted
short-lived pending token and returns the plaintext token once. Repeating the
prepare call while it is still pending returns the same token. `POST
/rotate-token/commit` applies it asynchronously, returns the token again for
recovery, and purges the encrypted pending token when the operation is done.

Ingress is internal on target port 8080. Customer data-plane traffic enters
through APIM at `https://www.asmdb.cloud/db/<24-char-suffix>/...`; the control
plane uses the internal Container Apps FQDN for proxy, stats, wake,
prepare-upgrade, and upgrade operations. Tier resources and quotas follow the current contract: free
`0.25/0.5Gi/0..1`, 3, 393,216 usable rows; standard
`0.5/1Gi/0..1`, 20, 1,572,864 usable rows; premium
`1.0/2Gi/1..1`, 10, 3,145,728 usable rows; with
`maxReplicas: 1` on every tier. The API returns `201` once Azure accepts the
create request; it does not wait for the app to become running.

Free and standard instances can scale to zero. The exec proxy treats Azure's
cold-start HTML page as retryable and eventually returns `instance_starting`
rather than forwarding HTML. Stats and list views do not wake instances;
`POST /wake` is the explicit non-blocking warm-up trigger.

Instance app updates are stop-then-start rather than rolling because the engine
holds an exclusive lock and `maxReplicas` is 1. Token rotation is two-phase:
`POST /rotate-token` prepares and returns a recoverable token without touching
the app, then `POST /rotate-token/commit` applies it asynchronously. This means
a client timeout cannot leave the customer with an unknown working token.
Upgrade also waits for the replacement revision to become healthy; on failure
the previous app spec is restored.

Upgrade preparation calls the sidecar's narrow `POST /v1/prepare-upgrade` route
with the per-instance platform token. That route must not accept caller-supplied
engine commands or paths; the control plane aborts the upgrade on any non-OK
prepare response.
