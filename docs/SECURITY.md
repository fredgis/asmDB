# Security policy and threat model

This document describes the security posture asmdb has today. It is not a
claim of hardening.

## Supported versions

| Version | Supported for security reports |
|---|---|
| `main` | Yes, best effort |
| Released tags | Best effort for the latest release only |
| Older commits / forks | No |

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security
Advisories for `fredgis/asmDB`. Do not open a public issue with exploit details.

There is no bug bounty. Triage, fixes and disclosure timing are best effort and
depend on maintainer availability.

## Trust boundary

asmdb is a local, single-binary database engine. It reads commands from stdin and
reads/writes files in the local filesystem. Anyone who can run the binary with a
database name, write commands to its stdin, or modify the adjacent files can
influence engine behaviour.

The sensitive files are:

- `<db>.dat` — primary data file;
- `<db>.wal` — write-ahead log used for recovery;
- `<db>.cdc` — change-data-capture log.

Anyone who can write any of those files is inside the trust boundary.

## Engine security posture

The engine itself has:

- no authentication;
- no authorisation;
- no encryption at rest;
- no encryption in transit; the engine has no network protocol;
- no audit log.

Access control is entirely external: whoever can run the binary and read or
write the files has full access to the database.

The hosted service does not change the engine. It wraps one engine process per
database instance and provides the network, identity and storage controls around
it. Keep those two layers separate: an engine binary copied out of the service
still has the limitations above.

## Hosted service boundary

In asmdb Cloud, instances are not public endpoints. The deployed network is:

- VNet `asmdb-vnet` (`10.20.0.0/16`) with separate subnets for Container Apps,
  API Management and private endpoints.
- An internal Container Apps environment (`internal: true`) at static IP
  `10.20.1.197`. Its Container Apps domain is not publicly resolvable.
- API Management in Developer SKU, External VNet mode, as the only public front
  door.
- Private endpoints for Blob storage, the Azure Files share and the container
  registry, each with its own private DNS zone linked to the VNet.

Blob storage has `publicNetworkAccess: Disabled` and
`allowSharedKeyAccess: false`. The control plane uses managed identity; there is
no storage account key to leak or rotate for Blob. Instance data is on Azure
Files NFS 4.1. NFS carries no account key; access is authorised by network reach
inside the VNet. SMB was deliberately not used because Container Apps SMB mounts
require a storage account key.

The honest exception is Azure Container Registry. Public network access remains
enabled so images can be built with ACR Tasks from a workstation. Runtime pulls
use the private endpoint. Closing that exception would require a dedicated build
agent pool inside the VNet; that is not deployed.

## Hosted request path and TLS

Database traffic is routed through the gateway by path:

- `https://www.asmdb.cloud/db/<instance>/v1/rows`
- `https://www.asmdb.cloud/db/<instance>/mcp`
- `https://www.asmdb.cloud/db/<instance>/health`

Everything after the instance identifier is forwarded verbatim to the instance,
so the REST and MCP contracts are unchanged except for the `/db/<instance>`
prefix.

The gateway accepts HTTPS only and forwards to the control plane over HTTPS.
Container Apps ingress does not set `allowInsecure`; the platform default is
false, so HTTP is redirected to HTTPS. There is no plaintext hop in the request
path.

The public hostname is `https://www.asmdb.cloud`, with `asmdb.cloud`
redirected to it by the registrar. That hostname uses a Let's Encrypt
certificate that expires every 90 days. The manual renewal procedure and alert
are documented in [`SAAS.md`](SAAS.md) §8b.

## Hosted authentication and authorisation

The service uses two credentials, and they are never interchangeable.

**Management API** operations such as create, list, delete and rotate require a
Microsoft Entra ID v2 access token. The server verifies the token against the
tenant JWKS: signature, issuer, audience and expiry. The `groups` claim must
contain the object id of the `ASMDB_ADMIN` security group. A valid token from a
user outside that group is rejected as `403`, not `401`, because the caller is
authenticated but not allowed. ID tokens are not accepted in place of access
tokens, and no payload is trusted without signature verification. If the Entra
configuration is absent, the management API fails closed.

The browser flow is authorization-code with PKCE. There is no client secret in
the image, repository or app settings. Tenant, client and group ids are supplied
as environment variables and exposed to the browser through a config endpoint
rather than being baked into a committed script. The previous shared admin key
has been removed.

**Data-plane** calls to a database's REST API, MCP endpoint and browser terminal
use the instance access token. It is an opaque bearer string issued at creation,
returned with the endpoint once, and stored by the control plane only as a hash.
Comparisons are constant time.

Tokens are not retrievable after creation. Rotation is available at
`POST /api/v1/databases/{id}/rotate-token` and is authenticated with Entra, not
with the instance token; that is intentional, because rotation is needed when
the instance token is lost. Rotation stops the instance, applies the new token,
starts it again and confirms health. The new token arrives as an environment
variable, which creates a new Container Apps revision. A rolling update cannot
work with the engine's exclusive lock, so the old process must exit before the
replacement can open the database; if the replacement does not become healthy,
the control plane rolls back to the previous token and revision.

## Hosted durability and isolation

Each instance mounts a durable volume at `/data`. A Container App's local
filesystem is discarded on restart and scale-to-zero; the control plane refuses
to start if the volume is not configured.

One Azure Files NFS share serves the platform. The mount sub-path is the
instance id, so each database owns one directory and cannot see another's. Every
tier sets `maxReplicas` to `1`; this is not a tuning knob. The engine is a
single-writer process with an exclusive lock, so a second replica would not add
capacity and may not open the database at all.

The engine transaction limit remains 4 096 distinct rows. The service layer may
chunk requests, but it cannot make one engine transaction larger.

## Executable hardening limitations

The engine is assembled directly with `nasm -f bin`; there is no linker, no C
runtime and no library loader for the engine itself.

The current executable images are not memory-hardened:

- Linux uses a hand-written ELF64 `ET_EXEC` image with one `PT_LOAD` segment
  mapped at `0x400000` with `PF_R | PF_W | PF_X`.
- Windows uses a hand-written PE64 image at `0x400000` with one section marked
  code, execute, read and write.

Consequences:

- There is no W^X separation: code and data share a readable, writable and
  executable image.
- There is no PIE/relocation model for the engine image, so there is no
  address-space randomisation of the engine itself.
- Any memory-corruption bug should be treated as directly exploitable.

This is a known limitation. The roadmap item is to split code and writable data
into separate non-RWX mappings and add a relocation/PIE strategy before treating
the engine as suitable for hostile inputs.

## File validation and corruption detection

asmdb validates several on-disk invariants:

- `.dat` header magic, storage format, record size, capacity and live-count
  limits are checked when opening a database.
- `.wal` frames use CRC32 checks around committed frames.
- `.cdc` has a header CRC32, per-frame CRC32, frame trailers and dense sequence
  checks.
- The `VERIFY` command scans the table and checks row status values, live row
  invariants, hash reachability and the header live count.

These checks detect accidental corruption, torn writes and incompatible files.
They are not an attacker model. CRC32 is not a MAC; anyone who can deliberately
rewrite the files can also recompute CRC32 values or craft internally
consistent malicious data.

## File permissions

On Linux, data files are created with mode `0600`. On Windows, files inherit the
directory ACL from the containing directory.

## Concurrency model

asmdb supports one writer plus any number of `--reader` sessions:

- Windows uses a byte-range `LockFileEx` writer lock.
- Linux uses `flock` with exclusive, non-blocking locking.

Linux `flock` is advisory. The model assumes cooperating processes use asmdb's
locking protocol; another process with filesystem access can ignore the lock and
modify the files.
