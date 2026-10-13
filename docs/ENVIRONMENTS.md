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

Worker vars `ADMIN_FIREBASE_PROJECT_ID` (never equal to `FIREBASE_PROJECT_ID` — `preflight` fails it) and `ADMIN_REQUIRE_MFA="true"` (staging/prod — `preflight` fails anything else). First super admin: `DATABASE_URL=<direct url> node apps/api/scripts/create-super-admin.mjs owner@company.com`, then that person signs in to the admin project with that verified email. Admin users live in a **separate Firebase project** (ERD Module 11): a user ID token
can never validate against admin routes, even if a scope check is forgotten.

Neon: staging is a **branch of production schema, not data**. Never create staging
from a production branch that contains real PII — create it empty and seed it.

## Secrets & config

| Name | Where | Envs | Notes |
|---|---|---|---|
| Hyperdrive id, KV id, Firebase project id | `wrangler.toml` | all | not secret; `preflight --env X` blocks `REPLACE_ME` |
| `DOCUMENTS_SIGNING_KEY` (Module 3b) | `wrangler secret put --env X` | all | HMAC key for document PUT/GET URLs (≥ 32 random bytes: `openssl rand -base64 48`). The R2 bucket has no public access and no S3 credentials — the Worker binding is the only door. Rotating it invalidates outstanding URLs (≤ 15 min) and nothing else. |
| `PAYOUT_ENC_KEY` (Module 9) | `wrangler secret put --env X` | all | AES-GCM key, 32 bytes base64; rotate via key id prefix |
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

## ⚠ The Firebase emulator variable

With `FIREBASE_AUTH_EMULATOR_HOST` set, `firebase-auth-cloudflare-workers` accepts **unsigned** tokens — anyone
can impersonate any user. Three layers stop it reaching a deployed Worker:
1. `lib/firebase.ts` `libraryEnv()` strips it unless `ENVIRONMENT === 'development'`, even if set as a var/secret.
2. `pnpm preflight --env X` fails when `wrangler.toml` declares it for a deployed env.
3. SECURITY.md pre-deploy checklist: `wrangler secret list --env production` must not show it.
It belongs in `apps/api/.dev.vars` only.

## Why separate Firebase projects

ID tokens carry the project id as `aud`. A staging token is rejected by production — a test account can never call production.

## Local development

```bash
pnpm install
docker compose up -d db                        # Postgres 16 on :5433 (stands in for Neon)
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/visaitaly
pnpm db:migrate
psql "$DATABASE_URL" -f apps/api/seed/seed_dev_legal.sql      # dev only; never production
cp apps/api/.dev.vars.example apps/api/.dev.vars
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"
pnpm api:dev
```

Auth locally: (1) a real **dev Firebase project** (closest to production), or (2) the **Auth emulator**
(`firebase emulators:start --only auth`, uncomment the emulator line in `.dev.vars` — local only).

Before any PR: `pnpm typecheck && pnpm lint:openapi`, and `pnpm db:roundtrip` against a throwaway `*_ci`/`*_test` DB.

## Creating staging / production resources (one-time)

```bash
# Neon: project in the region nearest the Workers serving Pakistan (PRD §4: co-locate); "staging" branch from main.
wrangler hyperdrive create visaitaly-staging-db --connection-string="<neon staging URL>"
wrangler hyperdrive create visaitaly-prod-db    --connection-string="<neon main URL>"
wrangler kv namespace create PUBLIC_JWK_CACHE_KV --env staging
wrangler kv namespace create PUBLIC_JWK_CACHE_KV --env production
# Paste the ids into the matching REPLACE_ME_* slots in apps/api/wrangler.toml.
```

Verify region choice and the Hyperdrive connection-string type against current Cloudflare/Neon docs at setup time.
