# Architecture Decision Records

One file per decision that took discussion or would be expensive to reverse.
Accepted ADRs are binding until a later ADR supersedes them. Never edit an
accepted ADR's decision — write a new one and mark the old `Superseded by NNNN`.

Status values: `Proposed` · `Accepted` · `Superseded by NNNN` · `Rejected`.

| # | Decision | Status |
|---|---|---|
| 0001 | Cloudflare Workers + Hono for the API | Accepted (PRD §4) |
| 0002 | Neon via Hyperdrive, `pg` + Drizzle, one client per request | Accepted (PRD §4) |
| 0003 | Firebase for identity only; entitlement lives in Neon | Accepted (PRD §5) |
| 0004 | App-level device sessions and eviction | Accepted |
| 0005 | Custom SQL migration runner, expand → backfill → contract | Accepted |
| 0006 | Unauthorised access returns 404, never 403 | Accepted |
| 0007 | Content never ships in migrations; `preflight` enforces | Accepted |
| 0008 | `/v1/me` as a top-level, single-round-trip launch snapshot | Accepted |
| 0009 | Flutter stack: Riverpod, Dio, go_router, freezed | Accepted |
| 0010 | Checklist engine data design (Module 3) | Proposed — re-confirm |
| 0011 | Three environments with per-env bindings | Proposed — re-confirm |

## Template

```markdown
# NNNN — Title
Status: Proposed | Date: YYYY-MM-DD

## Context
What forces are at play. Constraints, numbers, PRD references.

## Decision
What we do. One paragraph, imperative.

## Consequences
What gets easier, what gets harder, what we must now always do.

## Alternatives considered
Each with the reason it lost.
```
