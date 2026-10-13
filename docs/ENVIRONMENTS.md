# Environments, secrets, deploys, backups

Three environments. **Nothing is shared between them** — not a database, not a
Firebase project, not a KV namespace, not an R2 bucket. A staging bug must never
be able to touch a production row.

## Matrix

| | development | staging | production |
|---|---|---|---|
| Worker | `wrangler dev` (local) | `visaitaly-api-staging` | `visaitaly-api` |
| API URL | `http://localhost:8787` | `api-staging.visaitaly.pk` | `api.visaitaly.pk` |
| Neon | branch `dev` (or local Postgres 16) | branch `staging` | `main` branch, PITR on |
| Hyperdrive | `visaitaly-db-dev` | `visaitaly-db-staging` | `visaitaly-db-prod` |
| Firebase (users) | `visaitaly-dev` + Auth emulator optional | `visaitaly-staging` | `visaitaly-prod` |
| Firebase (admins) | `visaitaly-admin-dev` | `visaitaly-admin-staging` | `visaitaly-admin-prod` (MFA enforced) |
| R2 bucket | `visaitaly-docs-dev` | `visaitaly-docs-staging` | `visaitaly-docs-prod` |
| KV (JWK cache) | own | own | own |
| Flutter flavor | `dev` | `staging` | `prod` |
| Seeds | dev seeds allowed | dev seeds allowed | **never** (preflight blocks draft legal) |
| Deploy trigger | manual | push to `main` | tag `v*` + required reviewer |

Admin users live in a **separate Firebase project** (ERD Module 11): a user ID token
can never validate against admin routes, even if a scope check is forgotten.

Neon: staging is a **branch of production schema, not data**. Never create staging
from a production branch that contains real PII — create it empty and seed it.

## Secrets & config

| Name | Where | Envs | Notes |
|---|---|---|---|
| Hyperdrive id, KV id, Firebase project id | `wrangler.toml` | all | not secret; `preflight --env X` blocks `REPLACE_ME` |
| `DOCUMENTS_SIGNING_KEY` (Module 4) | `wrangler secret put --env X` | all | R2 signed-URL HMAC |
| `PAYOUT_ENC_KEY` (Module 10) | `wrangler secret put --env X` | all | AES-GCM key, 32 bytes base64; rotate via key id prefix |
| `FCM_SERVICE_ACCOUNT` (Module 5) | `wrangler secret put --env X` | staging, prod | used by Cron only, never request path |
| `DATABASE_URL` | GitHub Environment secret | staging, production | **direct** Neon URL for migrations, not Hyperdrive |
| `CLOUDFLARE_API_TOKEN` | GitHub Environment secret | staging, production | scoped: Workers Scripts:Edit, Hyperdrive:Read, KV:Read — nothing else |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Environment secret | staging, production | |
| `API_BASE_URL` | GitHub Environment variable | staging, production | used by the post-deploy smoke test |
| `STAGING_API_URL`, `PRODUCTION_API_URL` | GitHub repo variables | — | uptime workflow |
| `.dev.vars` | local file, gitignored | development | local-only overrides |

Flutter ships **no API secret** (SECURITY.md). Only `google-services.json` per
flavor, which is designed to be public. Enable **Firebase App Check** (Play
Integrity) on prod before launch — free, and it blocks scripted signups.

**Rotation:** every secret above has an owner and a rotation date in the team
password manager. Rotate `CLOUDFLARE_API_TOKEN` and `DATABASE_URL` on any team
change.

## Deploy flow

```
PR ──► CI: typecheck · OpenAPI lint · wrangler dry-run ×3 · migration round-trip · tests
 │
merge to main ──► CI ──► staging: migrate → preflight --env staging → deploy → /health smoke
 │
git tag v1.2.3 ──► CI ──► [required reviewer approves] ──► production: migrate → preflight → deploy → smoke
```

- Migrations run **before** the Worker deploy. Safe because every migration is
  expand-only (SCALE.md); the old Worker keeps working against the new schema.
- A **contract** migration (drop column) ships only in a release *after* the one
  that stopped reading the column.
- **Rollback a bad deploy:** `npx wrangler rollback --env production` (Worker only —
  Cloudflare keeps prior versions). Do **not** run `db:rollback` in production;
  ship a forward-fix migration instead. `.down.sql` files exist to prove
  reversibility in CI and for dev, not as a production undo button.

Flutter release: Play Console internal track → closed testing → production with
staged rollout (10% → 50% → 100%). `minSupportedAppVersion` in `app_config`
forces upgrades (API returns `APP_VERSION_UNSUPPORTED`).

## Backups & disaster recovery

| Asset | Mechanism | RPO | RTO |
|---|---|---|---|
| Neon (prod) | Neon point-in-time restore. **Restore window depends on plan** — free tier window is short; confirm on the paid plan before launch. | minutes | < 1 h |
| Neon logical backup | weekly `pg_dump` from GitHub Actions → private R2 bucket `visaitaly-backups`, 8 weeks kept | 7 d | hours |
| R2 documents | object versioning **not** relied on; documents are user-reuploadable. Payment proofs + receipts are critical → included in the weekly backup sync | 7 d | hours |
| Config / content | `app_config`, `requirements`, `legal_versions` are in Neon → covered above. Requirement seeds also in git. | — | — |

**DR drill (quarterly, written into the ops calendar):** restore the latest
backup into a fresh Neon branch, point staging at it, run `preflight`, open the app
against staging. Record the time taken in `docs/runbooks/` (create on first drill).
An untested backup is not a backup.

## Local development

```bash
pnpm install
# Postgres: Neon dev branch, or local
export DATABASE_URL="postgres://postgres@localhost:5432/vip_dev"
pnpm db:migrate
psql "$DATABASE_URL" -f apps/api/seed/seed_dev_legal.sql
# Worker against local Postgres without Hyperdrive
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"
pnpm api:dev
```

Before any PR: `pnpm typecheck && pnpm lint:openapi` and, against a throwaway
`*_ci`/`*_test` DB, `pnpm db:roundtrip`.
