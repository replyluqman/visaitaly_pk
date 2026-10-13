---
description: Write a schema migration following expand → backfill → contract
argument-hint: <short_name> — <what changes>
---

Create the next migration for: $ARGUMENTS

Rules (CLAUDE.md "Schema change protocol", docs/SCALE.md §4):

1. Next number = highest in `apps/api/migrations/` + 1. Write `NNNN_<name>.sql` and
   `NNNN_<name>.down.sql`. Never edit an applied migration.
2. If an existing populated column changes: this migration is the **expand** step
   only. Plan backfill and contract as separate later migrations and say so.
3. Forbidden in one migration: type change on a populated column, `NOT NULL` without
   a finished backfill, a rename, unrelated changes together.
4. Every new FK gets a covering index. Every filter/sort column is indexed — name the
   query each index serves in a comment.
5. New append-only table: retention rule in the header comment.
6. No content (legal text, requirements, copy) — that goes in `apps/api/seed/`.
7. Update the Drizzle schema in `apps/api/src/db/schema/` and `docs/DATA-MODEL.md`.
8. Verify locally: `pnpm db:migrate && pnpm db:rollback && pnpm db:migrate`, then the
   FK-cover query from `.github/workflows/ci.yml`.
9. Flag any breaking change to the user **before** writing it.
