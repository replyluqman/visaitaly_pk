# Testing protocol

No module is "done" until all applicable gates pass. The next module does not
start until the previous one has passed. This is a hard rule — it is the whole
reason this document exists.

Record the result in the module's `MODULE-0N-*.md` under a `## Test results`
heading: date, what was run, what was found, what was fixed.

---

## The five gates

| # | Gate | Backend | Flutter |
|---|---|---|---|
| 1 | Static | `pnpm typecheck` clean, zero `any` in new code | `flutter analyze` clean |
| 2 | Unit | Services, pure logic, error mapping | Notifiers, repositories, mappers |
| 3 | Contract / Integration | Routes against a real local DB | Widget + `integration_test` against local API |
| 4 | Query & load | `EXPLAIN ANALYZE` on every new query at realistic volume | Frame timing on list screens |
| 5 | Security | `docs/SECURITY.md` module checklist | Same checklist, client section |

Gates 1–3 run on every commit. Gates 4–5 run once per module, before it is
signed off.

---

## Gate 1 — Static

- `pnpm typecheck` / `flutter analyze` must be clean, not "clean except".
- No `any`, no `dynamic`, no `!` non-null assertion on API data in new code.
- No `TODO` left in a module being signed off. Either fix it or move it to
  `STATE.md` as an explicit open item.

## Gate 2 — Unit

**Backend.** Services only — they hold all logic, so they are all that needs
unit coverage. Route files are thin and are covered by Gate 3.

Every service function needs, at minimum:
- happy path
- each `AppError` code it can throw
- every access-level branch (`free` / `premium` write vs `grace_read_only` /
  `expired` deny)
- the boundary condition its invariant protects — e.g. `current_stage = NULL`
  producing `stage_pending`, `onboarding_state` never regressing from `complete`

**Flutter.** `flutter_test` + `mocktail`. Repositories with a mocked Dio,
notifiers with mocked repositories. The Dio interceptor gets its own test per
`SESSION_TERMINAL_CODES` entry — each one must wipe the session and route to
login.

## Gate 3 — Contract / Integration

**Backend.** Run against a real local Postgres, not mocks. Mocked SQL tests
prove nothing about SQL.

For each endpoint:
- 200 shape matches the `@visaitaly/shared` type exactly
- 401 with no token, 401 with a valid token but unknown/evicted device
- 422 body shape on invalid input, with `details` populated
- 404 on another user's resource id — **never** 403, so ids cannot be probed
- the write actually persisted (re-read it)
- idempotency where claimed

**Ownership test is mandatory on every resource route.** Create data as user A,
attempt every verb as user B, expect 404 on all of them. This is the single most
common way a multi-tenant app leaks data and it is trivial to test.

**Flutter.** `integration_test` against the local API from Gate 3. At minimum
per module: the primary flow end to end, app restart persistence, and offline /
network-failure rendering.

## Gate 4 — Query & load

Run against a seeded database at realistic volume, not 10 rows. Seed targets:

| Table | Seed to |
|---|---|
| users | 30,000 |
| applicants | 75,000 |
| applicant_requirements | 2,000,000 |
| notifications | 1,000,000 |
| documents | 200,000 |

Then, for every new or changed query:

1. `EXPLAIN ANALYZE` it. **A `Seq Scan` on any table above 10k rows fails the
   gate.** Add the index and re-run.
2. Record the timing in the module doc.
3. Budgets: p95 DB time under 50 ms, Worker CPU under 10 ms (the free-tier
   ceiling and our binding constraint), end-to-end p95 under 500 ms.

Also verify, per module:
- every list endpoint paginates — an unpaginated list endpoint fails the gate
- no N+1: one request should issue a bounded number of queries regardless of
  result count. Log the query count in dev and assert on it.

## Gate 5 — Security

Work the module checklist in `docs/SECURITY.md`. Record findings in the module
doc even when the finding is "none".

---

## Local test environment

Backend integration and load tests run against local Postgres, never against the
Neon branch that production uses. Use a Neon dev branch or local Docker
Postgres, seeded from `seed/`.

Seed scripts live in `seed/` and are **not** part of the migration chain. They
are never run in production. Nothing in `migrations/` may contain sample or
draft content.

---

## Definition of done, per module

```
[ ] Gate 1  static clean
[ ] Gate 2  unit — every error code and access branch covered
[ ] Gate 3  integration — including the cross-user 404 ownership test
[ ] Gate 4  EXPLAIN ANALYZE at volume, no seq scans, pagination present
[ ] Gate 5  security checklist worked
[ ] migration has a .down.sql that actually reverses it, tested
[ ] MODULE-0N doc updated with test results
[ ] STATE.md updated
```
