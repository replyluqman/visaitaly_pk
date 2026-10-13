# 0008 — `/v1/me` as a top-level, single-round-trip launch snapshot
Status: Accepted | Date: 2026-10

## Context
Every launch needs identity, entitlement, device count, legal state and applicant
progress. Four queries over Hyperdrive would cost latency and CPU on the hottest
endpoint.

## Decision
`GET /v1/me` (own router, not `/v1/auth/me`) returns `MeResponse` from one SQL
statement (`loadMeSnapshot`, CTEs). It also records `last_seen_at`. Login returns the
same shape plus `session`. Entitlement buckets are computed against `now()`.

## Consequences
- New launch-time fields extend this query, not add a call. Re-measure CPU each time.
- If the statement ever grows past the budget, split by moving rarely-changing parts
  to a client-cached endpoint, not by adding sequential queries.
