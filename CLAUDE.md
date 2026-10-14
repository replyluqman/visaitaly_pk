# VisaItaly PK — engineering brief

Read `docs/VisaItalyPK-PRD-v3_1.md` (spec) and `docs/VisaItalyPK-Screens-v2.md` (UX)
before changing behaviour. PRD v3.0 is superseded — do not follow it.

Process docs, all binding:
- `docs/TESTING.md` — the five gates. **No module starts until the previous one passes all of them.**
- `docs/SECURITY.md` — per-module security checklist
- `docs/SCALE.md` — 30k-user targets, indexing, retention, expand–contract
- `docs/adr/` — accepted decisions; supersede with a new ADR, never by drifting
- `docs/ERD.md` (planned schema, Modules 3–10) · `docs/api/openapi.yaml` (`pnpm lint:openapi`) · `docs/design/` (glass-lite UI) · `docs/ROADMAP.md` · `docs/LAUNCH-CHECKLIST.md` — plan docs: build against them and update them in the same PR when a module changes them

Everything else (architecture, API contract, data model, environments, deploy,
runbook, privacy, Flutter): `docs/INDEX.md`. Current status: `STATE.md`.

Slash commands in `.claude/commands/`: `/new-module`, `/migration`, `/gate-check`,
`/security-review`. Use them — they encode the steps below.

Per-module design notes live in `apps/api/MODULE-0*.md`. Write one for every new
module, and record test results in it.

## Stack (locked — do not re-litigate)

**Backend**

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| Router | Hono |
| DB | Postgres (Neon) via Cloudflare Hyperdrive — mandatory, PRD §4 |
| ORM | Drizzle (`drizzle-orm/node-postgres` + `pg`) |
| Auth | Firebase email + password, via `firebase-auth-cloudflare-workers` — no SMS/phone/anonymous/social, no custom claims; planned exit to native auth at ≈35k MAU (`docs/adr/0013-auth-exit-plan.md`) |
| Storage | R2 (zero egress) |
| Validation | zod, schemas exported from `@visaitaly/shared` |
| Monorepo | pnpm workspaces |

**Flutter (Android MVP)**

| Layer | Choice |
|---|---|
| State | Riverpod |
| Networking | Dio, manual repository classes (no Retrofit) |
| Routing | go_router, with redirect guards for auth / onboarding / access level |
| Models | freezed + json_serializable, mirroring `@visaitaly/shared` |
| Storage | `flutter_secure_storage` — device UUID, never API secrets |
| Testing | `flutter_test` + `mocktail`, `integration_test` |

## Layout

```
apps/api/
  migrations/         NNNN_name.sql + NNNN_name.down.sql
  seed/               dev-only seed data — NEVER in the migration chain
  src/
    index.ts          worker entry, mounts every router
    env.ts            Env bindings type
    db/client.ts      per-request pg client
    db/schema/        one file per table group + index.ts barrel
    lib/              errors, validate, firebase, app-config
    middleware/       auth (requireSession)
    modules/<name>/   <name>.service.ts (logic) + <name>.routes.ts (HTTP)
packages/shared/src/  types + zod schemas + error codes, as @visaitaly/shared
docs/                 PRD, Screens, process docs, contracts, runbooks, adr/
apps/mobile/          Flutter app (not started) — has its own CLAUDE.md
.claude/              slash commands + permission deny rules
```

Routes do HTTP only — parse, call service, map errors. Services own all SQL,
all business logic, and all authorisation, and never touch `Request`/`Response`.
Cross-module calls go service → service, never routes → routes.

## Invariants — violating these is a bug, not a preference

1. **Zero hardcoding.** Every tunable reads `app_config` via `readConfig()` with a
   named fallback constant.
2. **`relationship_category`** (`spouse|child|parent`) is derived server-side from
   `relationship_code` and denormalised onto `applicants`. Never accept it from a
   client.
3. **`applicants.current_stage` is nullable on purpose.** NULL = Screen 7 has not
   run, which drives `onboarding_state = 'stage_pending'`. Never add a DEFAULT.
4. **`onboarding_state` is always server-recomputed** by `recomputeOnboardingState()`
   and never regresses from `complete`.
5. **8 canonical journey stages.** Screen 7 maps to `(currentStage, nullaOstaStatus)`.
6. **Legal acceptance matches on `(doc_type, version)`**, not version id. No IP is
   stored on `legal_acceptances` (§19).
7. **Access levels:** `free` and `premium` may write; `grace_read_only` and
   `expired` may not (§7). Enforced in the service, never only in the client.
8. **Derive, don't store,** anything computable: `is_expired_pending`, readiness %,
   `not_applicable` display status.
9. **Dates: cast to text in SQL.** `node-postgres` turns `DATE` into a
   local-midnight `Date` and shifts the day.
10. **Case generation runs in the same transaction as the stage write.** Either both
    land or both roll back — never a half-generated case.

## Auth rules (ADR 0013)

- Outside the auth module, identity is `users.id` only — never `firebase_uid`.
- Token verification stays behind one interface so a second issuer can be added.
- The Eligibility Quick Check needs no account and no token.
- The ADR 0013 migration-readiness checklist is part of the build, not a later project.

## Data access rules

- Every user-owned read and write filters by `userId` **in the SQL WHERE clause**.
  Never fetch-then-check in application code.
- Unauthorised access returns **404, never 403** — a 403 confirms the row exists.
- Every list endpoint paginates, by cursor on `(created_at, id)`. Never `OFFSET`.
- No `SELECT *`. Select the columns the response needs.
- Every foreign key and every filter/sort column is indexed. Verified by
  `EXPLAIN ANALYZE` in Gate 4.
- No N+1. Query count per request stays bounded regardless of result count.

## Schema change protocol

**Expand → backfill → contract, as three separate migrations.** Never mutate a
live column in place. See `docs/SCALE.md` for the full pattern.

- Every migration ships its `.down.sql`, and the rollback is actually tested.
- Never edit an applied migration.
- Never in one migration: a type change on a populated column, `NOT NULL` without
  a completed backfill, a rename, or multiple unrelated changes.
- Any append-only table declares its retention rule in the migration that creates it.
- **Real content never ships inside a migration.** Legal text, requirement
  definitions, copy — all of it goes in `seed/` and is applied by hand. A
  migration reaches every environment automatically, so placeholder content in
  one silently satisfies the checks that are supposed to block launch.
  Config defaults (`app_config`, `relationships`) are schema-adjacent and do
  belong in the migration.
- Flag breaking changes before writing them.

## Before deploying

```
pnpm preflight --env staging|production
```

CI runs this before every deploy (`.github/workflows/ci.yml`); environments and secrets: `docs/ENVIRONMENTS.md`.
Every migration change must pass `pnpm db:roundtrip` (apply → full rollback → re-apply → identical schema) against a
throwaway `*_ci`/`*_test` database; CI enforces it.

Asserts what a written checklist gets skipped on: no `REPLACE_ME` left in
`wrangler.toml`, no secret committed there, every migration applied, no
placeholder legal text live, no uncovered foreign key. Exits non-zero so CI can
gate on it. Add a check here rather than a line to a runbook.

## Module completion

A module is done when `docs/TESTING.md`'s checklist is fully ticked — static,
unit, integration including the cross-user 404 ownership test, `EXPLAIN ANALYZE`
at volume, and the security checklist. Then update the module doc and `STATE.md`.

Errors: throw via the `AppError.*` factories. Codes are the contract — clients branch
on `code`, never on `message`. HTTP status comes from `STATUS_BY_CODE` in
`lib/errors.ts`, never from the call site. A new code means updating
`packages/shared/src/errors.ts`, `STATUS_BY_CODE` (the compiler enforces it),
`docs/API-CONTRACT.md`, and deciding whether it is session-terminal.

If unsure about a library version or platform limit, verify — do not guess.
There is a live example in `lib/firebase.ts` (`verifyIdToken` arity).
