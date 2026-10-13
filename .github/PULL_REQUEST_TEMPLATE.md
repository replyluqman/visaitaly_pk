## What and why

<!-- One paragraph. Link the PRD section or module doc this implements. -->

Module / area:
PRD §:

## Type

- [ ] Feature (module work)
- [ ] Fix
- [ ] Migration (expand / backfill / contract — say which)
- [ ] Docs / tooling only

## Gates (`docs/TESTING.md`)

- [ ] **1 Static** — `pnpm typecheck` clean, no `any` / non-null `!` on API data in new code
- [ ] **2 Unit** — every `AppError` code and access-level branch covered
- [ ] **3 Integration** — incl. the **cross-user 404** ownership test on every resource route
- [ ] **4 Query & load** — `EXPLAIN ANALYZE` at seeded volume, no seq scan over 10k rows, lists paginate
- [ ] **5 Security** — module checklist in `docs/SECURITY.md` worked, findings recorded
- [ ] N/A for the gates not applicable — reason:

## Schema

- [ ] No schema change
- [ ] New migration pair `NNNN_name.sql` + `.down.sql`, rollback tested (up → down → up)
- [ ] No applied migration edited
- [ ] No type change, rename, or `NOT NULL` without a finished backfill in this migration
- [ ] New append-only table declares its retention rule in the migration

## Contract

- [ ] `docs/API-CONTRACT.md` updated (or: no API change)
- [ ] `docs/DATA-MODEL.md` updated (or: no schema change)
- [ ] New error code added to `packages/shared/src/errors.ts` **and** noted for the Flutter client
- [ ] `CHANGELOG.md` updated

**Breaking for shipped clients?** <!-- yes/no. If yes: what, and the client migration path. -->

## Security / privacy

- [ ] Every user-owned query filters by `userId` in the SQL `WHERE`
- [ ] No PII, document content or tokens in logs
- [ ] No secret in `wrangler.toml` or committed files
- [ ] New PII column added to the deletion path in `docs/DATA-PRIVACY.md`

## How to verify

<!-- Commands or steps a reviewer can run. Paste real output for anything gate-related. -->
