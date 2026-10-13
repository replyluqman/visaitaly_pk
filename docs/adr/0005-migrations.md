# 0005 — Custom SQL migration runner, expand → backfill → contract
Status: Accepted | Date: 2026-09

## Context
At 30k users, an in-place column change on a populated table locks it or breaks the
running app version. Rollbacks must be real, not theoretical.

## Decision
Plain SQL files `NNNN_name.sql` + `NNNN_name.down.sql`, applied by
`apps/api/scripts/migrate.mjs` (`up | down | status`), tracked in `schema_migrations`
with checksums. Every change to a live column is three migrations: expand (add
nullable/new), backfill, contract (constrain/drop) — separate deploys.

## Consequences
- Applied migrations are immutable (CI fails a PR that modifies one; checksum
  catches it at runtime).
- CI runs up → full rollback → up on every PR.
- Drizzle schema files are hand-kept in sync; drizzle-kit is not the source of truth.

## Alternatives considered
drizzle-kit push/generate (generated diffs hide destructive changes, weak down
migrations), Prisma Migrate (stack mismatch).
