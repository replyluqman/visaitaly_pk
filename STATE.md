# State — Phase 0 (pre-code pack) complete · Modules 1–2 code complete, tests pending

## Phase 0 — delivered on `claude/baseline-import`

| Item | File |
|---|---|
| Full MVP ERD, Modules 4–11 | `docs/ERD.md` |
| API contract (live + planned), lints clean | `docs/api/openapi.yaml` |
| Glass-lite design system, tokens, 6 screen mockups | `docs/design/` |
| CI (typecheck, OpenAPI lint, wrangler ×3, migration round-trip), staging/prod deploys, uptime, encrypted weekly backup | `.github/workflows/` |
| Environments, secrets, deploy flow, DR | `docs/ENVIRONMENTS.md` |
| Logging, Cron heartbeats, alerts, Crashlytics | `docs/OBSERVABILITY.md` |
| Analytics event plan → PRD §21 metrics | `docs/ANALYTICS.md` |
| Consent, export, erasure design | `docs/GDPR.md` |
| Requirement content template + guide; canned responses draft | `docs/content/` |
| Owner actions (accounts, legal, bank, courier, content) | `docs/LAUNCH-CHECKLIST.md` |
| Timeline | `docs/ROADMAP.md` |

**Bug fixed:** `[env.production]` in `wrangler.toml` had no Hyperdrive/KV bindings
(not inherited), so a prod deploy would have run without a DB. All envs now declare
full bindings; CI fails on the wrangler "not inherited" warning.

**Changed:** `preflight` now takes `--env staging|production` and checks only that
env's placeholders. New `pnpm db:roundtrip` (verified locally on Postgres 16:
3 migrations up → down → up, identical 152-object schema).

**Blocking decisions for the owner:** ERD O1 (payable currency — blocks Module 6),
courier partner, lawyer engagement, verified requirement content.

---

# Modules 1–2 detail

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

**The checklist engine is now `0004`, not `0003`.**

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

- **3 `REPLACE_ME` values in `wrangler.toml`** — Hyperdrive id, KV namespace id,
  Firebase project id. From your Cloudflare and Firebase dashboards; `preflight`
  blocks deploy until they are set.
- **`resolveEntitlement()` is still the Module 1 stub.** Returns
  `{ premiumApplicantIds: [], hasAnyPremium: false }` unconditionally, so
  `GET /v1/me` reports no premium for everyone. Your notes say this and
  `loadMeSnapshot` were written; neither is in this tree. The premium columns are
  on `applicants` and indexed (`applicants_user_premium_idx`), so the query is
  ready to write. **This is the top item before Module 3** — the checklist engine
  gates on entitlement.
- Confirm `requires_dob` per relationship with the content owner. Seeded: spouse
  `false`, child and parent `true`.
- No tests exist. `docs/TESTING.md` defines five gates; Modules 1–2 have cleared
  Gate 1 and most of Gate 4. Gates 2, 3 and 5 are unstarted — in particular the
  cross-user 404 ownership test has never been run against the routes.

## Commands

```bash
pnpm install
pnpm -r typecheck

export DATABASE_URL="postgres://user:pass@host/db"   # direct, NOT Hyperdrive
pnpm db:migrate
node apps/api/scripts/migrate.mjs status
pnpm db:rollback

psql "$DATABASE_URL" -f apps/api/seed/seed_dev_legal.sql   # dev only

pnpm preflight              # before any production deploy
cd apps/api && npx wrangler dev
```

## Next — Module 4: checklist engine

`requirements` + `applicant_requirements`. 5 statuses, 3 badges,
non-applicable-with-reason output. Fill `generateCase()` in
`modules/checklist/checklist.service.ts`, set `case_generated_at`.

Confirmed decisions:

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
