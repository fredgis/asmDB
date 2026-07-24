# asmdb — SaaS Productization Plan

> How we take **asmdb** — the x86-64 assembly engine specified in
> [`ENGINE.md`](ENGINE.md) — and offer it as a **hosted, multi-tenant cloud
> service**: *agent-memory-as-a-service*.
>
> **Scope & separation of concerns.** The **engine stays 100% assembly** (that
> is the whole point, and its roadmap lives in [`ENGINE.md §12`](ENGINE.md#12-roadmap)).
> Everything in *this* document is the **service layer around** that engine —
> the network protocol, control plane, multi-tenancy, auth, billing, and
> operations. That layer is **not required to be assembly**; it should be built
> in whatever is safest and fastest to ship (Rust and Go are the leading
> candidates). The assembly engine is the **data plane**; everything here is the
> **control plane and edge**.

---

## Table of contents

1. [Product thesis](#1-product-thesis)
2. [Target users & use cases](#2-target-users--use-cases)
3. [High-level architecture](#3-high-level-architecture)
4. [The engine as a data-plane node](#4-the-engine-as-a-data-plane-node)
5. [Wire protocol & APIs](#5-wire-protocol--apis)
6. [Multi-tenancy & isolation](#6-multi-tenancy--isolation)
7. [Authentication & authorization](#7-authentication--authorization)
8. [Quotas, rate limiting & metering](#8-quotas-rate-limiting--metering)
9. [Durability, backup & disaster recovery](#9-durability-backup--disaster-recovery)
10. [High availability & replication](#10-high-availability--replication)
11. [Security & compliance](#11-security--compliance)
12. [Observability & SRE](#12-observability--sre)
13. [Deployment topology](#13-deployment-topology)
14. [Pricing & packaging](#14-pricing--packaging)
15. [Go-to-market roadmap](#15-go-to-market-roadmap)
16. [Risks & open questions](#16-risks--open-questions)

---

## 1. Product thesis

**asmdb Cloud** is the fastest, cheapest place to give an AI agent durable,
long-term memory.

The flagship offering is **hosted agent memory**: an agent connects to a
**remote MCP endpoint** (HTTP/SSE) and gets the exact five tools it already
knows locally — `memory_store`, `memory_recall`, `memory_search`,
`memory_list`, `memory_delete` — but backed by a managed, replicated,
per-tenant store instead of a local `.exe`. No infrastructure, no schema
design, no ORM: an API key and one MCP URL.

Why this can win:

- **Cost per memory is dominated by storage + syscalls**, and the engine spends
  almost nothing on either — a fixed 256-byte record, a single hash probe, and
  a WAL append. That translates directly into a lower unit cost we can price
  aggressively against Postgres/pgvector-based memory services.
- **The MCP interface is already the product.** We are not inventing a new API
  surface; we are hosting one agents already speak.
- **The moat is boring reliability**, not the assembly novelty — but the
  assembly core is a credible "fastest memory backend" wedge for marketing and
  for genuinely low latency/cost.

---

## 2. Target users & use cases

| Segment | Need | asmdb Cloud fit |
|---------|------|-----------------|
| **AI agent builders** | durable per-user/per-session memory without running a DB | remote MCP endpoint, namespaced by tenant + agent |
| **Framework / tool authors** (LangChain, CrewAI, custom) | a drop-in memory provider | thin SDK wrapping the HTTP API + MCP |
| **Indie devs / hackers** | cheap key→value+text store with search | free tier, one URL, no ops |
| **Enterprises** | isolated, auditable agent memory with data residency | dedicated tenancy, VPC peering, audit logs |

Primary workload shape: **many small writes** (`store`), **frequent point
reads** (`recall`), **occasional substring search** (`search`/`list`). This is
exactly the CRUD profile the engine is tuned for — not analytical joins.

---

## 3. High-level architecture

```
                         ┌──────────────────────────────────────────────┐
   agents / SDKs         │                 CONTROL PLANE                 │
   ────────────          │  (Rust/Go — NOT assembly)                     │
   MCP client  ─┐        │                                              │
   HTTP client ─┼──TLS──▶│  API gateway ─ auth ─ rate limit ─ metering  │
   gRPC client ─┘        │        │                    │                │
                         │        │ route by tenant     │ emit usage    │
                         └────────┼─────────────────────┼──────────────┘
                                  │                     ▼
                                  │              billing / usage store
                                  ▼
                         ┌──────────────────────────────────────────────┐
                         │                  DATA PLANE                    │
                         │  asmdb engine nodes (100% assembly)           │
                         │                                              │
                         │   node A            node B          node C   │
                         │  ┌────────┐        ┌────────┐      ┌────────┐ │
                         │  │asmdb.exe│  ...   │asmdb.exe│ ... │asmdb.exe││
                         │  │ tenant  │        │ tenant  │     │ tenant  ││
                         │  │ shards  │        │ shards  │     │ shards  ││
                         │  └───┬────┘        └───┬────┘      └───┬────┘ │
                         └──────┼──────────────────┼───────────────┼─────┘
                                ▼                  ▼               ▼
                         object storage: WAL shipping + snapshots (S3/Blob)
```

- **Edge / control plane** (Rust or Go): TLS termination, authn/z, rate limiting,
  quota enforcement, request routing, usage metering, the MCP-over-HTTP bridge,
  and the REST/gRPC facade. Stateless, horizontally scalable behind a load
  balancer.
- **Data plane**: pools of **asmdb engine processes**, each owning one or more
  **tenant shards** (a shard == one `<db>.dat` + `<db>.wal`). The engine is
  unchanged; a small **sidecar** (Rust/Go) supervises each process, speaks the
  engine's protocol on one side and the control plane on the other, and ships
  WAL/snapshots to object storage.
- **Object storage** (S3 / Azure Blob / GCS): the source of truth for
  durability beyond a single node — streamed WAL segments plus periodic
  snapshots.

---

## 4. The engine as a data-plane node

The engine needs **no product logic** added to it; the service is built by
*wrapping* it. Two integration options, cheapest first:

1. **Stdio sidecar (available today).** Exactly what the current MCP server
   does: launch `asmdb.exe <db>`, drive it over stdin/stdout with the FIFO
   framing described in `ENGINE.md`. A Rust/Go sidecar hosts one process per
   shard and multiplexes tenant requests onto it. **This is the MVP path** — it
   requires zero engine changes.
2. **Binary wire protocol (engine roadmap v3.0).** The engine grows a
   length-prefixed request/response codec *in assembly* (see
   [`ENGINE.md §12`](ENGINE.md#12-roadmap), "Binary wire protocol"). The sidecar
   then talks a real protocol over a socket/pipe instead of parsing REPL lines —
   lower overhead, cleaner framing, no ASCII-art on the hot path.

Either way the **contract** between control plane and engine is: *one shard =
one engine process = one WAL*. Scaling out = more processes/nodes, sharded by
tenant. This keeps the assembly engine single-writer and simple, and pushes all
distribution concerns into the (non-assembly) control plane.

---

## 5. Wire protocol & APIs

Three public surfaces, all backed by the same engine operations:

### 5.1 Remote MCP (flagship)

- **Transport:** MCP over **HTTP + SSE** (the standard remote-MCP transport).
- **Tools:** identical to local — `memory_store`, `memory_recall`,
  `memory_search`, `memory_list`, `memory_delete`.
- **Onboarding:** the agent is configured with a URL + API key; nothing else
  changes versus the local server. This is the "connect your agent to cloud
  memory in 30 seconds" story.

### 5.2 REST (for non-MCP integrations)

```
POST   /v1/memories            {key, content, tag?, value?}   → upsert
GET    /v1/memories/{key}                                     → recall
GET    /v1/memories?query=...                                 → search
GET    /v1/memories                                           → list (paginated)
DELETE /v1/memories/{key}                                     → delete
```

JSON in/out, API-key or JWT auth, cursor pagination on `list`/`search`.

### 5.3 gRPC (for high-throughput / server-to-server)

Same five operations as a `.proto` service; HTTP/2 multiplexing for callers
issuing many small ops. Optional; REST + MCP cover most users.

> All three map onto the engine's existing verbs. `store` = the MCP upsert
> (INSERT, retry as UPDATE); `recall` = SELECT by id; `search` = FIND; `list` =
> SELECT *; `delete` = DELETE. Keys are hashed to the engine's `u64 id`
> (64-bit FNV-1a) in the control plane, exactly as the current MCP server does.

---

## 6. Multi-tenancy & isolation

Isolation model, from strongest to cheapest — offered as **tiers**:

| Tier | Isolation unit | Mechanism | For |
|------|----------------|-----------|-----|
| **Dedicated** | tenant → own node(s) | one or more engine processes on dedicated VMs/containers, own disks | enterprise, data residency |
| **Shard-per-tenant** | tenant → own `<db>.dat`/`<db>.wal` | one engine process (or a slot in a pool) per tenant | standard paid |
| **Namespace-in-shard** | tenant → `tag` prefix inside a shared shard | control plane prefixes/validates every `key` and `tag` with a tenant id | free / very small tenants |

- Default paid tier is **shard-per-tenant**: strong blast-radius isolation
  (a tenant's data is a distinct file + WAL), simple backup/restore per tenant,
  and it matches the engine's single-writer design.
- **Namespace-in-shard** packs many tiny free-tier tenants into one process to
  amortise the 64 MiB region; the control plane is responsible for rewriting and
  enforcing the `tenant/agent/…` key namespace so tenants can never read each
  other's keys. Cross-tenant leakage here is a **control-plane bug class**, so
  namespace enforcement is centralised and heavily tested.
- **Placement:** a tenant→shard→node mapping lives in the control-plane
  metadata store (e.g. Postgres). Rebalancing = move a shard's files + replay
  tail WAL on the destination.

---

## 7. Authentication & authorization

- **API keys** for the simple case: a hashed key per tenant/project, sent as a
  bearer token; instantly revocable; scoped (read-only vs read-write).
- **JWT / OAuth 2.0 / OIDC** for enterprises: bring-your-own IdP, short-lived
  tokens, `tenant_id` + scopes as claims.
- **Per-request authz:** the gateway resolves token → tenant → allowed shard(s)
  and injects the tenant namespace *before* the request reaches any engine
  process. The engine itself never sees credentials and never makes trust
  decisions — it only ever receives already-authorized, already-namespaced ops.
- **mTLS** available for gRPC/VPC customers.

---

## 8. Quotas, rate limiting & metering

- **Rate limiting** at the gateway (token bucket per API key): requests/sec and
  concurrent connections, with burst allowances by tier.
- **Quotas:** max memories, max total bytes, max search QPS per tenant. The
  engine's fixed capacity (2^18 slots/shard today) makes per-shard limits
  natural; exceeding it triggers a shard split (roadmap partitioning) or an
  upsell.
- **Metering:** the gateway emits a usage event per op (`tenant`, `op`, `bytes`,
  `timestamp`) to a durable stream (Kafka/Kinesis → warehouse). Billing derives
  from these. Metering is **at the edge, not in the engine**, so the hot path
  stays a hash probe + WAL append.

---

## 9. Durability, backup & disaster recovery

The engine already gives **node-local** durability (WAL + crash recovery). The
service adds **beyond-the-node** durability:

- **WAL shipping:** the sidecar streams committed WAL segments to object storage
  continuously. RPO shrinks to the shipping interval (seconds).
- **Snapshots:** periodic full `<db>.dat` snapshots to object storage (cheap —
  it is one contiguous region) as a recovery base so WAL replay stays bounded.
- **Point-in-time restore:** snapshot + WAL replay up to a timestamp, per tenant
  (clean because each tenant is its own shard/WAL).
- **Backups are per-tenant and portable:** a tenant export is literally their
  `.dat` + WAL tail, which also enables self-serve export and account deletion
  (GDPR erasure).

RPO/RTO targets by tier: e.g. free = best-effort daily snapshot; standard = ≤60s
RPO via WAL shipping; enterprise = ≤5s RPO + warm standby (see §10).

---

## 10. High availability & replication

- **Primary/replica per shard via WAL streaming.** The primary engine process is
  the single writer; the sidecar streams its WAL to one or more **replica**
  processes that apply the same idempotent redo path used at recovery. Reads can
  be served from replicas (eventual consistency) for `recall`/`search`.
- **Failover:** if a primary node dies, the control plane promotes a replica
  (its WAL is caught up to the last shipped segment), remaps the shard, and
  fences the old primary. Because a shard is single-writer, promotion is a
  metadata flip, not a consensus dance.
- **Multi-writer is explicitly out of scope** for the engine — distribution is a
  control-plane responsibility (sharding), not an engine feature. This keeps the
  assembly core simple and correct.
- **Optional consensus** (Raft in the control plane) only for the *shard→node
  placement* metadata, never for the data path.

---

## 11. Security & compliance

- **Encryption in transit:** TLS 1.3 everywhere (edge), mTLS for VPC/gRPC.
- **Encryption at rest:** the sidecar encrypts `.dat`/WAL bytes and object-store
  objects (envelope encryption, per-tenant data keys via KMS). The engine writes
  plaintext to its local file; the sidecar/volume layer encrypts — keeping crypto
  *out of the assembly hot path* while still meeting at-rest requirements. (A
  future engine option could XOR/AES a page on write, but it is not required.)
- **Tenant isolation** as in §6; namespace enforcement centralised and fuzzed.
- **Audit logs:** every control-plane action (auth, CRUD, admin) is logged
  immutably per tenant, exportable for SOC 2 / ISO 27001 evidence.
- **Compliance path:** SOC 2 Type II first (it is what agent-platform buyers
  ask for), then ISO 27001; GDPR/CCPA data-subject export & erasure are natural
  given per-tenant shards; offer **data residency** via region-pinned dedicated
  tenancy.
- **Secrets:** API-key hashes and data keys in a managed secrets store / KMS,
  never in the engine or its files.

---

## 12. Observability & SRE

- **Metrics:** per-tenant ops/sec, p50/p99 latency, error rate, shard fill %,
  WAL lag, checkpoint duration; per-node CPU/mem/disk. Exposed via Prometheus,
  dashboards in Grafana.
- **Tracing:** distributed traces (OpenTelemetry) from gateway → sidecar →
  engine op, so a slow `recall` is attributable to a shard/node.
- **Logging:** structured logs at the edge + sidecar; the engine's stdout is
  captured by the sidecar and surfaced as structured events.
- **SLOs:** e.g. 99.9% availability standard / 99.95% enterprise; p99 `recall`
  < 10 ms same-region. Error budgets drive release pace.
- **Alerting & runbooks:** shard-near-capacity, WAL-lag-high,
  replica-behind, node-down → paged with documented recovery steps (promote
  replica, restore from snapshot+WAL).

---

## 13. Deployment topology

- **Packaging:** the engine binary + sidecar in a container image; engine data
  on a fast local NVMe volume, replicated to object storage.
- **Orchestration:** Kubernetes. Engine shards are **stateful** →
  `StatefulSet`s with persistent volumes; the control plane is **stateless** →
  `Deployment`s behind an ingress/LB. An operator/controller manages
  shard placement, splits, and failover.
- **Regions:** start single-region multi-AZ; add regions for latency + data
  residency. Object-storage replication for cross-region DR.
- **Windows vs Linux:** the engine is Win32/PE today. For cheap Linux container
  fleets, the **Linux syscall port** on the engine roadmap
  ([`ENGINE.md §12`](ENGINE.md#12-roadmap), v3.0) is the enabler; until then,
  engine nodes run on Windows containers/VMs while the control plane runs
  anywhere.

---

## 14. Pricing & packaging

| Tier | Isolation | Limits (illustrative) | Durability/HA | Price model |
|------|-----------|-----------------------|---------------|-------------|
| **Free** | namespace-in-shard | 10k memories, low QPS | daily snapshot | $0 |
| **Pro** | shard-per-tenant | 1M memories, higher QPS | ≤60s RPO WAL shipping | usage: per-1M ops + per-GB-month |
| **Team** | shard-per-tenant (pooled nodes) | multi-project, RBAC | read replica, ≤10s RPO | seats + usage |
| **Enterprise** | dedicated nodes | custom | warm standby, ≤5s RPO, residency, SSO, audit export | annual contract |

Cost advantage narrative: the engine's fixed 256-byte record + single hash
probe + WAL append means **predictable, low cost per memory**, so usage pricing
can undercut Postgres/pgvector-backed memory services while keeping healthy
margin. (Ground marketing latency/throughput claims in the honest
`ENGINE.md`/README benchmark numbers — don't over-promise the bulk-durable path
until incremental checkpoint lands.)

---

## 15. Go-to-market roadmap

Phased so each stage ships independent value; **none of these require changing
the engine's assembly**, though some ride engine roadmap items.

### Phase 0 — Hosted MCP MVP (single region, single node)
- Rust/Go gateway wrapping the **existing stdio sidecar** (§4 option 1).
- Remote MCP over HTTP/SSE + API keys + namespace-in-shard multitenancy.
- Object-storage snapshots (basic durability). One region, best-effort SLA.
- **Goal:** an agent connects to a cloud MCP URL and stores/recalls memory.

### Phase 1 — Paid tiers & real durability
- Shard-per-tenant isolation; WAL shipping (≤60s RPO); REST API + SDKs.
- Metering + usage billing; rate limits/quotas; dashboards.
- **Goal:** first paying customers on Pro.

### Phase 2 — HA & scale
- Read replicas + failover; partitioning/shard-split for large tenants
  (rides engine v3.0 partitioning); multi-AZ.
- gRPC surface; team tier + RBAC.
- **Goal:** 99.9% SLA, production-grade.

### Phase 3 — Enterprise & compliance
- Dedicated tenancy, VPC peering, SSO/OIDC, audit export, data residency.
- SOC 2 Type II, then ISO 27001; at-rest encryption via KMS.
- Multi-region DR.
- **Goal:** land enterprise agent platforms.

### Phase 4 — Performance edge as a feature
- Adopt engine roadmap wins (binary wire protocol, SIMD scans, incremental
  checkpoint) to publish credible "fastest/cheapest agent memory" benchmarks.
- Optional Linux engine port for cheaper fleets.
- **Goal:** turn the assembly core into a defensible performance/cost story.

---

## 16. Risks & open questions

- **Single-writer per shard** caps a single tenant's write throughput to one
  engine process. Mitigation: partitioning (engine v3.0) + shard-split. Open
  question: automatic vs manual split triggers.
- **Windows-only engine** raises fleet cost vs Linux containers until the
  syscall port lands. Open question: prioritise the Linux port vs run Windows
  nodes for the data plane initially.
- **Namespace-in-shard leakage risk** (free tier) is a control-plane
  correctness burden. Mitigation: centralised namespace enforcement + fuzzing +
  default to shard-per-tenant for anyone who pays.
- **Fixed capacity per shard** (2^18 slots) means we must split *before* the
  hash table saturates (load factor 0.75). Needs a capacity-watchdog + dynamic
  resize (engine v1.0).
- **At-rest encryption** is a sidecar/volume responsibility today; some buyers
  may require engine-level field encryption. Open question: whether to add an
  optional AES page path in assembly later.
- **Benchmark honesty:** the bulk-durable path currently trails SQLite; do not
  build pricing/marketing on numbers the incremental-checkpoint work hasn't
  delivered yet.

---

> **Remember the split:** the [engine](ENGINE.md) is the assembly heart and its
> roadmap is engine-only; **this** document is the product wrapper and may use
> any technology. Keep new work in the correct lane.
