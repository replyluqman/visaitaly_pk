# 0002 — Neon via Hyperdrive, `pg` + Drizzle, one client per request
Status: Accepted (PRD §4) | Date: 2026-09

## Context
Need real Postgres with scale-to-zero cost. Workers cannot hold a connection pool.
Unpooled connections burn Neon compute hours.

## Decision
Neon Postgres, reached only through Hyperdrive, with `pg` (node-postgres) and Drizzle
(`drizzle-orm/node-postgres`). One `pg.Client` per request, closed via
`ctx.waitUntil`. Raw SQL through `db.execute(sql\`…\`)` is allowed and preferred for
anything non-trivial; Drizzle schema files mirror the migrations for typing.

## Consequences
- `Db` type = `PgDatabase<NodePgQueryResultHKT, …>` so services accept a transaction too.
- `db.execute<T>` needs `T` as a `type` alias (interfaces lack an index signature).
- `DATE` must be cast to text in SQL — `pg` shifts it to local midnight.
- Migrations run with a **direct** Neon URL, never through Hyperdrive.
- Not the Neon serverless driver — incompatible with Hyperdrive.

## Alternatives considered
`@neondatabase/serverless` over HTTP (no Hyperdrive pooling benefits), D1 (not
Postgres, weaker tooling), Prisma (bundle size + CPU on Workers).
