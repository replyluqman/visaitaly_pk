# State — Phase 0 done · Modules 1–2 gated (Phase 1) · Module 3 next

## Phase 1 — Modules 1–2 gates (done)

`cd apps/api && TEST_DATABASE_URL=postgres://…/x_test pnpm test` → **66 tests**, real Postgres, real middleware/SQL
(only Firebase token verification is stubbed). `pnpm gate4` → EXPLAIN at 30k users / 75k applicants, all queries ≤ 0.15 ms,
no big Seq Scan. Results and security checklist: `apps/api/MODULE-01-AUTH.md`, `MODULE-02-APPLICANTS.md`.
Both run in CI (`.github/workflows/ci.yml`) — **CI itself still never executed on GitHub**.

Bugs the gates found and fixed: `createDb` never connected (every request would hang in prod); login rewrote a deleted
user's PII; same-email re-signup 500 (migration 0004); no `X-Request-Id`.

Still open after Phase 1: Worker CPU p99 unmeasured (needs staging); rate limiting is an edge WAF rule, not configured;
redundant `legal_acceptances_user_idx`; ADR 0010/0011 Proposed.


## Phase 0 — delivered

| Item | File |
|---|---|
| Planned schema, Modules 3–10 (indexes, retention, open items O1–O4) | `docs/ERD.md` |
| Full API contract, built + planned, lints clean | `docs/api/openapi.yaml` (prose of the built part: `docs/API-CONTRACT.md`) |
| Glass-lite design system, tokens, 6 screen mockups | `docs/design/` |
| CI (typecheck, OpenAPI lint, wrangler ×3, immutability, content grep, migration round-trip, FK cover) + staging/prod deploys + uptime + encrypted weekly backup | `.github/workflows/` |
| Analytics plan, privacy/consent/erasure design, content templates, canned responses draft, owner checklist | `docs/ANALYTICS.md`, `DATA-PRIVACY.md`, `content/`, `LAUNCH-CHECKLIST.md` |

Two parallel working copies of this project were merged on branch `claude/baseline-import`; module numbering follows
`docs/ROADMAP.md` (checklist = Module 3, migration 0005).

**Blocking decisions for the owner:** ERD **O1** (payable currency — blocks Module 6), courier partner, lawyer engagement,
verified requirement content. ADR 0010 and 0011 are still **Proposed**.

## Verified at merge (executed, not claimed)

| Check | Result |
|---|---|
| `pnpm -r typecheck` | clean |
| `loadMeSnapshot` SQL on Postgres 16 with 5 applicants (active+future, active+past, grace+future, grace+past, no stage) | 1 premium, 1 grace, 2 excluded; `awaitingStage=1`; pending legal `disclaimer` — correct |
| Migration round-trip (0001–0003 up → down ×3 → up) | leaves only `schema_migrations`; identical 152-object schema |
| FK covering-index audit | 0 uncovered |
| `preflight --env` | scoped per environment; fails a staging block that declares the emulator var |
| `libraryEnv()` emulator guard | host kept only when `ENVIRONMENT === 'development'` |
| OpenAPI lint | valid |
| GitHub Actions workflows | **not yet run** — first run happens on push to `main` / a PR |



## Verified this pass (executed, not claimed)

| Check | Result |
|---|---|
| `pnpm -r typecheck` | clean, both workspaces |
| `wrangler deploy --dry-run` | bundles, 864 KiB / 164 KiB gzip |
| Migrations 0001–0003 on fresh Postgres 16 | all apply |
| Full rollback 0003 → 0001 | reverses completely, only `schema_migrations` left |
| Re-apply after rollback | clean |
| Checksum tamper guard | correctly refuses an edited applied migration |
| FK index audit | **0 uncovered** (was 2) |
| `preflight` with placeholder live | correctly blocks, exit 1 |
| Dev legal seed re-run | idempotent, 1 row |
| **2026-10-14** restored M2 `auth.service` on Postgres 16 | 3rd login evicts oldest device; `/v1/me` returns `legal`, `applicants`, `entitlement` |
| Entitlement buckets with real rows | active+future → premium · grace+future → grace · grace past / access past → excluded |
| CI steps run locally (migrate up → rollback ×3 → up, FK audit, content grep) | pass |
| Re-signup same email, new Firebase uid | **fails** — `users_email_lower_uq` (open P1) |

## A — resolved: FK covering indexes

`0003_fk_indexes.sql` + `.down.sql`. Adds:

```
applicants_relationship_code_idx       ON applicants (relationship_code)
legal_acceptances_legal_version_idx    ON legal_acceptances (legal_version_id)
```

Postgres indexes the referenced key automatically but never the referencing
column, so a parent delete or key update seq-scanned the child. Purely additive,
rollback is a plain `DROP`.

`CONCURRENTLY` deliberately not used: it cannot run inside a transaction, and
the runner wraps each migration in one so a failure never half-applies. Both
tables are small when this runs. If a future index targets a large table, it
belongs in its own migration run manually outside the transactional runner —
noted in the migration header.

**The checklist engine is now `0005`, not `0003`.**

## B — resolved: placeholder legal text out of the migration chain

The `0.1-draft` disclaimer `INSERT` is removed from `0002` and now lives in
`apps/api/seed/seed_dev_legal.sql`, applied by hand and made idempotent via
`ON CONFLICT (doc_type, locale, version) DO NOTHING`.

A doc rule alone would not have held, so the constraint is now mechanical:

**`apps/api/scripts/preflight.mjs`** (`pnpm preflight`) fails a deploy on
unset `REPLACE_ME` bindings, a secret committed to `wrangler.toml`, unapplied
migrations, and **any `is_current` legal version whose version string looks like
a draft**. It warns on missing `app_config` keys, doc types with no published
version, and uncovered foreign keys. Non-zero exit, so CI can gate on it.

Verified: with the dev seed applied it reports
`FAIL Placeholder legal text is live: disclaimer v0.1-draft`.

Side effect, intended: a fresh dev database now returns 404 from
`/v1/legal/current` and onboarding sits at `disclaimer_pending` until the seed
runs. That is exactly the production-before-launch state, so it gets exercised
in dev instead of on launch day.

> **One-time action for anyone with an existing dev database.** `0002` was
> edited, so its checksum changed and the runner will refuse to proceed. Nothing
> is deployed anywhere, so this is safe now and would not be later. Drop and
> recreate the dev DB, then `pnpm db:migrate` and apply the seeds. From here on
> the never-edit-an-applied-migration rule is absolute.

## C — resolved: `/v1/me`

Neither the PRD nor the Screens doc specifies any endpoint path, and no Flutter
client exists yet, so this was a free design choice rather than a compatibility
constraint.

`auth.routes.ts` now exports two routers: `authRoutes` (mounted `/v1/auth`,
carrying `POST /session`) and `meRoutes` (mounted `/v1/me`). The payload is the
app-launch snapshot — identity, entitlement, onboarding state, device count —
not an auth operation; nesting it under `/auth` would imply the client
re-authenticates on every launch.

## Endpoints

```
GET    /health
POST   /v1/auth/session
GET    /v1/me
GET    /v1/devices                    DELETE /v1/devices/:deviceId
GET    /v1/legal/current              GET /v1/legal/current/:docType
POST   /v1/legal/accept
PATCH  /v1/onboarding/applicant-count
GET    /v1/reference/relationships
GET    /v1/applicants                 POST /v1/applicants
GET    /v1/applicants/:id             PATCH /v1/applicants/:id
DELETE /v1/applicants/:id             PATCH /v1/applicants/:id/stage
```

## Still open

### P1 — before any deployed environment
1. ~~Emulator bypass guard~~ — **done** (`libraryEnv()` + `preflight`).
2. ~~Email uniqueness~~ — **done** (migration 0004 drops `users_email_lower_uq`).
3. ~~`preflight` scope~~ — **done** (`--env`).

### P2 — before launch
4. ~~Gates 2, 3, 5 for Modules 1–2~~ — **done** (Phase 1).
5. ~~`registerSession` must refuse deleted users~~ — **done**.
6. ~~`X-Request-Id` header~~ — **done**; per-request structured access log still open (`OBSERVABILITY.md`).
7. Rate limiting on `/v1/auth/session` (Cloudflare rule first).
8. Move the inline SQL in `reference.routes.ts` into a service (layering rule).
9. Drop redundant `legal_acceptances_user_idx` in a later migration.
10. Fill `REPLACE_ME` values (3 envs × Firebase project, Hyperdrive id, KV id).
11. Confirm CORS domain (`*.visaitaly.pk` is an assumption).
12. Confirm `requires_dob` per relationship with the content owner (spouse false,
    child/parent true seeded).
13. Decide device-row retention (purge non-active > 90 days?) — `DATA-MODEL.md`.

### Needs your confirmation
- ADR 0010 (checklist data design) and ADR 0011 (staging env) are **Proposed**.
- PRD §24 open items (courier, CMS defaults, WhatsApp number, canned responses, Urdu
  owner, lawyer scope).

## Commands

```bash
pnpm install
pnpm -r typecheck

export DATABASE_URL="postgres://user:pass@host/db"   # direct, NOT Hyperdrive
pnpm db:migrate
pnpm db:status
pnpm db:rollback

psql "$DATABASE_URL" -f apps/api/seed/seed_dev_legal.sql   # dev only

pnpm preflight --env production   # before any production deploy (CI does it)
pnpm db:roundtrip                  # against a throwaway *_ci DB
pnpm api:dev
```

## Next — Module 3: checklist engine (migration 0005)

Schema draft: `docs/ERD.md` §Module 3. Contract draft: `docs/api/openapi.yaml` (`x-module: 3`).

Only after the P1 items and Gates 2/3/5 for Modules 1–2 (`docs/ROADMAP.md`).
Design recorded as ADR 0010 (Proposed).

`requirements` + `applicant_requirements`. 5 statuses, 3 badges,
non-applicable-with-reason output. Fill `generateCase()` in
`modules/checklist/checklist.service.ts`, set `case_generated_at`.

Decisions (agreed in discussion, re-confirm before writing 0005):

1. The migration carries `requirements` rather than waiting on CMS, and ships
   the final read shape so the CMS migration is purely additive.
2. Applicability as declarative SQL columns, not a JSONB rule blob — generation
   runs on the Screen 7 request path and must stay one `INSERT … SELECT` inside
   the CPU budget.
3. Store 4 statuses + `is_applicable`; return `not_applicable` as derived, so a
   relationship edit that flips a requirement out and back does not destroy
   progress.
4. Requirement rows update in place with an incrementing `version` int, because
   `applicant_requirements` FKs the stable requirement id.
5. Requirement definitions go in `seed/`, never in the migration — now enforced
   by `preflight` for legal text and by the same rule here.

Planned: `GET /v1/applicants/:id/checklist`, `GET /v1/checklist/:id`,
`PATCH /v1/checklist/:id`. Readiness folds into the applicants list query.

Out of scope: R2 upload, hash-check cron, `next_actions` materialisation, CMS
admin screens.
