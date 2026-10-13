# Scale

Target: 30,000 registered users.

## What that actually means

Registered is not concurrent. Visa applications are bursty and low-concurrency —
a user opens the app, does something for a few minutes, and leaves for days.
Realistic peak concurrency at 30k registered is in the low hundreds of requests
per second, and most of those are cacheable reads.

**Postgres does not struggle at this scale.** No sharding, no read replicas, no
caching layer, no queue is required. Anyone proposing an architecture change to
"handle 30k users" for this app is solving a problem we do not have.

What does bite at this scale is narrow and specific. It is listed below, and it
is all preventable now rather than fixable later.

## Table growth at 30k users

| Table | Estimated rows | Note |
|---|---|---|
| `users` | 30,000 | trivial |
| `applicants` | ~75,000 | ~2.5 per account |
| `documents` | ~200,000 | R2 objects, cost not perf |
| `applicant_requirements` | **~2,000,000** | 75k × ~25 requirements |
| `notifications` | **~1,000,000 / year** | unbounded without a policy |
| audit / activity log | **grows forever** | unbounded without a policy |

Two million rows is comfortable for Postgres *with the right indexes* and
miserable without them. The unbounded tables are the genuine risk — not because
they are slow at 1M rows, but because nothing stops them reaching 50M.

## The four rules that prevent a future rewrite

### 1. Index every access path, verify with EXPLAIN

Every foreign key gets an index. Every column used in a `WHERE`, `JOIN` or
`ORDER BY` gets one, composite where the query is composite. Gate 4 in
`docs/TESTING.md` enforces this: a `Seq Scan` on a table over 10k rows fails the
module.

Adding an index later is cheap and non-breaking. Discovering you need one during
an outage is not.

### 2. Cursor pagination, never offset

`OFFSET 10000` makes Postgres walk 10,000 rows and throw them away. Keyset
pagination on `(created_at, id)` stays constant-time at any depth.

Every list endpoint paginates. There is no exception for endpoints that "will
only ever return a few rows" — `applicant_requirements` was going to be a few
rows too.

### 3. Retention policy at creation time, not later

Any append-only table declares its retention rule in the same migration that
creates it:

- `notifications` — hard delete read notifications older than 90 days; keep
  unread. Cloudflare Cron, batched deletes, not one giant statement.
- activity / audit log — retain 12 months hot, then archive to R2 as compressed
  JSON and delete from Postgres. Compliance keeps the history; Postgres does not
  carry it.
- support threads — retain per the published policy; do not keep forever by
  default.

Retrofitting retention onto a 50M-row table means a long lock or a careful
batched backfill under pressure. Declaring it on day one costs one cron job.

### 4. Expand–contract for every schema change

Never mutate a live column. Three separate migrations:

1. **Expand** — add the new column or table. Nothing else. Old code still works.
2. **Backfill** — populate in batches, and dual-write from the application so
   both columns stay correct while the old one is still read.
3. **Contract** — only once no deployed code reads the old column, drop it.

Never in a single migration: type changes on a populated column, `NOT NULL`
without a default and a completed backfill, a rename, or multiple unrelated
changes.

This is the specific discipline that prevents the "we have to change the whole
schema" situation. Every change stays additive and individually reversible.

## Performance budgets

Enforced in Gate 4.

| Metric | Budget |
|---|---|
| Worker CPU per request | < 10 ms |
| DB time, p95 | < 50 ms |
| End-to-end, p95 | < 500 ms |
| Queries per request | bounded, and constant with respect to result count |

The 10 ms Worker CPU ceiling remains the binding constraint. It is a **CPU**
limit, not a request-count limit — batching many operations into one request
raises CPU and makes things worse. Keep request-path Workers thin, push set
operations into SQL where Postgres does the work, and cache on the client.

## Cost shape at 30k

Roughly ordered by what will actually appear on the bill:

1. **Neon compute** — the main line item. Watch autosuspend behaviour and
   connection usage via Hyperdrive.
2. **R2 storage** — ~200k documents. Egress is zero, which is why R2 was chosen;
   storage still accrues. A per-user upload quota is both a cost control and a
   security control.
3. **FCM** — free, but a cron that fans out to 30k users must batch and spread,
   not fire in one burst.
4. **Workers** — likely the smallest line, provided the CPU budget holds.

## Explicitly not needed at this scale

Do not add these without evidence from Gate 4 that they are required:

- Sharding or partitioning
- Read replicas
- Redis or an external cache layer
- A message queue
- Microservice split

Each adds permanent operational cost. The correct trigger to revisit is a
measured budget breach, not a projected user count.
