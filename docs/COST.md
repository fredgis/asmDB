# asmdb Cloud — cost model and pricing

Every rate here was read from the **Azure Retail Prices API** on **2026-07-25**
for **swedencentral**, in **USD**. Nothing is estimated from memory. The query
shape was:

```
https://prices.azure.com/api/retail/prices?currencyCode='USD'
  &$filter=serviceName eq '<service>' and armRegionName eq 'swedencentral'
```

Two rates could not be read back and are marked ⚠ — the API returned no row for
this region, so the published list price is used instead. They are small enough
that neither changes a pricing decision, but they are flagged rather than
quietly folded in.

A note on currency: the **EUR** price list returns `0` for every Azure Container
Apps consumption meter in this region, which is an artefact of that list rather
than a real price. USD is used throughout so the arithmetic is honest.

---

## 1. What the platform costs before a single customer exists

These resources exist whether there is one database or five hundred. This is the
number that has to be spread.

| Resource | Why it exists | Rate | $/month |
|---|---|---:|---:|
| API Management, Developer, 1 unit | the only public front door | $0.0658 / hour | **48.03** |
| Container Registry, **Premium** | Premium is the cheapest SKU that supports a private endpoint | $1.6666 / day | **50.73** |
| Standard static public IP | APIM's front-end address | $0.005 / hour | **3.65** |
| Private endpoints × 3 (blob, file, registry) ⚠ | keeps storage and the registry off the internet | $0.01 / hour each | **21.90** |
| Private DNS zones × 4 ⚠ | resolves the private endpoints inside the VNet | $0.50 / zone / month | **2.00** |
| Log Analytics ingestion, ~5 GB | container logs | $2.99 / GB | **14.95** |
| Blob storage, control-plane metadata | a few MB of JSON | — | **~0.50** |
| | | | **≈ 141.76** |

Two of these deserve comment.

**The registry costs more than the API gateway.** Premium is not wanted for
throughput or geo-replication; it is wanted because Basic and Standard cannot
have a private endpoint. $50.73/month is the price of the registry not being
reachable from the internet.

**The file share is not in this fixed table.** Premium Files is billed on
provisioned capacity, but a live one-row database on Azure Files NFS allocated
1,073,742,336 bytes. The engine's sparse `.dat` behaviour on local filesystems
does not carry through to this share, so storage is a per-database variable cost.

---

## 2. What one database costs

Instances run on Container Apps **Consumption**, which bills per second and
distinguishes a replica that is *serving a request* from one that is merely
*resident*:

| Meter | Rate | Per hour |
|---|---:|---:|
| vCPU, active | $0.000024 / vCPU-second | $0.0864 / vCPU |
| vCPU, idle | $0.000003 / vCPU-second | $0.0108 / vCPU |
| Memory | $0.000003 / GiB-second | $0.0108 / GiB |
| Requests | $0.40 / million | — |

The tier is the container size, and the sizes are not free choices: Consumption
accepts only fixed vCPU/memory pairs at a 1:2 ratio, and **0.25 vCPU / 0.5 GiB
is the floor**. There is nothing smaller to sell. The only lever below it is not
running at all, which is what scale-to-zero does.

Assumed usage — stated so it can be argued with:

| Tier | Size | Active h/month | Idle h/month | $/month |
|---|---|---:|---:|---:|
| `free` | 0.25 vCPU / 0.5 GiB | 20 | 0 (scales to zero) | **0.54** |
| `standard` | 0.5 vCPU / 1 GiB | 200 | 0 (scales to zero) | **10.80** |
| `premium` | 1 vCPU / 2 GiB | 200 | 530 (always warm) | **38.77** |

Each database also needs about **1 GiB** provisioned on the Premium Files NFS
share. At **$0.192 / GiB / month**, storage adds **$0.192 per database per
month**.

`premium` costs 3.6× `standard` for 2× the CPU because it never scales to zero:
about $21 of its bill is a replica sitting idle so the first request does not
wait for a cold start. That is precisely what the tier sells.

Request charges are ignored: at $0.40 per million, a database would need tens of
millions of calls a month before it rounded to a dollar.

The per-subscription free grant (180,000 vCPU-seconds and 360,000 GiB-seconds a
month) is also ignored. It is real, but it is granted once for the whole
subscription, so across hundreds of databases it amortises to noise. Counting on
it would make the model look better than it is.

---

## 3. Spreading the fixed cost

$141.76/month divided by the number of live databases:

| Databases | Fixed cost each |
|---:|---:|
| 50 | $2.84 |
| 100 | $1.42 |
| **300** | **$0.47** |
| 500 | $0.28 |
| 1000 | $0.14 |

300 is used as the reference point below. The curve flattens hard after that —
going from 300 to 1000 databases saves $0.33 per database, while going from 50
to 300 saves $2.36. The platform stops being dominated by its own overhead at
roughly **150 databases**.

A ceiling worth knowing: a Container Apps environment holds **500 apps**, so
database number 500 needs a second environment. That is a step change in the
fixed cost, not a gradual one.

Capacity now scales with the share: about **100 databases per 100 GiB**.

---

## 4. The free tier is paid for by the paid tiers

A `free` database is not free to run — it costs about **$1.20/month** all in
($0.54 compute + $0.47 amortised fixed + $0.192 storage). That has to come from
somewhere.

Assuming a mix of **60 % free / 30 % standard / 10 % premium** at 300 databases:

- 180 free instances × $1.2045 = **$216.81/month** of unfunded cost
- carried by 120 paying instances = **$1.81 per paying database**

If the free tier proves more popular than 60 %, this number is the first thing
that moves. At 80 % free it becomes about $4.82 per paying database and the standard
tier's margin is gone. **The three-instance cap on the free tier is a pricing
control, not a technical limit.**

---

## 5. Prices

Cost per paying database, then **+15 % margin on run**:

| | `standard` | `premium` |
|---|---:|---:|
| Compute | 10.80 | 38.77 |
| Storage | 0.192 | 0.192 |
| Fixed, amortised at 300 | 0.47 | 0.47 |
| Free-tier subsidy | 1.81 | 1.81 |
| **Cost** | **13.27** | **41.24** |
| +15 % | 15.26 | 47.43 |
| **Price** | **$15 / month** | **$49 / month** |

| Tier | Price | What it buys |
|---|---|---|
| `free` | **$0** | 0.25 vCPU / 0.5 GiB, sleeps when idle, max 3 per account |
| `standard` | **$15 / month** | 0.5 vCPU / 1 GiB, sleeps when idle, max 20 per account |
| `premium` | **$49 / month** | 1 vCPU / 2 GiB, always warm — no cold start, max 100 per account |

Every tier runs the identical engine, with the same 4 194 304-row ceiling and
the same durability. Tiers buy **latency and headroom, not features**. There is
no paid feature flag anywhere in the codebase and there is not meant to be one.
The published **$15** and **$49** prices still hold: storage adds about 19 cents
per database per month, which is noise against the standard and premium tiers.

---

## 6. What would break this

- **Fewer than 150 databases.** At 50, fixed cost alone is $2.84 per database
  and `standard` earns $9 a month against about $19.18 of cost. The model is a
  volume model; below volume it loses money.
- **A free tier that is too popular.** See §4.
- **`premium` customers who are genuinely busy.** The 200 active hours assumed
  above is a guess. A `premium` instance serving traffic 24/7 costs $79/month in
  compute — more than its price. Metering, listed as a stream in
  [`SAAS.md`](SAAS.md), exists to find out before it is a problem, and the honest
  answer may be a fourth tier rather than absorbing it.
- **Egress.** Not modelled. Bandwidth out of Azure is not free and no
  measurement of it exists yet. It is small for a 256-byte-row database, but
  "small" is not "measured".
- **A second environment past 500 databases**, which adds its own fixed cost.

## 7. What is deliberately not in here

Support, on-call, the domain, certificates, backups beyond the provisioned
share, and the cost of building the thing. This is the cost of *running* it,
which is what the 15 % is taken on.
