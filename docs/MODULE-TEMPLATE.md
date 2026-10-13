# Module NN — <Name>

> Copy to `apps/api/MODULE-NN-<NAME>.md` before writing code. Sections 1–5 are
> written and agreed **before** code. Sections 6–8 are filled as the gates run.
> The module is done when §8 is fully ticked.

## 1. Purpose

One paragraph. PRD §refs and Screens §refs this module serves.

## 2. Scope

In: … · Out (and which module owns it): …

## 3. Contract

| Method | Path | Auth | Request schema | Success | Errors |
|---|---|---|---|---|---|

New shared types/schemas in `packages/shared/src/<name>.types.ts`.
New error codes (each needs a row in `lib/errors.ts` `STATUS_BY_CODE` and a decision
on whether it is session-terminal): …
Breaking changes to existing endpoints: **none** / list with migration path.

## 4. Data

Migration `NNNN_<name>.sql` + `.down.sql`.

| Table | Columns | Indexes (and the query each serves) | Rows at 30k users | Retention |
|---|---|---|---|---|

Expand/backfill/contract steps if any existing column changes.
Content (seed/) vs config (migration) split.

## 5. Decisions

Each non-obvious choice, with the alternative rejected. Big ones get an ADR.
Deviations from the PRD, each with a reason.

## 6. Verify (manual)

Copy-pasteable `curl` sequence with expected status and body for the happy path and
each error.

## 7. Performance

`EXPLAIN (ANALYZE, BUFFERS)` for every new query at 30k-user volume (seed script
reference). Query count per request. CPU estimate for the hottest route.

## 8. Gates (`docs/TESTING.md`)

- [ ] G1 static — typecheck, bundle per env
- [ ] G2 unit — services' pure logic
- [ ] G3 integration — every route, every error code, **cross-user 404** for every id route
- [ ] G4 query/load — EXPLAIN at volume, no seq scan on user-owned tables, FK cover
- [ ] G5 security — `docs/SECURITY.md` per-module checklist, all items answered
- [ ] Migration up → down → up on a copy
- [ ] `API-CONTRACT.md`, `DATA-MODEL.md`, `CHANGELOG.md`, `STATE.md` updated

## 9. Client contract (Flutter)

What the app must do with this module: routing, caching, error handling.
