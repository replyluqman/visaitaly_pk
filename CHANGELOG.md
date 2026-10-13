# Changelog

All notable changes to the API and shared contract. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning will follow SemVer once there is a deployed API; until then everything is `Unreleased`.

Rule: any change to `docs/API-CONTRACT.md` gets a line here, and anything that breaks an existing client field is marked **BREAKING**.

## [Unreleased]

### Added
- **Pre-code pack (Phase 0):** `docs/ERD.md` (planned schema, Modules 3–10), `docs/api/openapi.yaml` (full contract, lints clean), `docs/design/` (glass-lite design system, tokens, mockups), `ANALYTICS.md`, `DATA-PRIVACY.md` (consent/export/erasure), `content/` (requirements template + guide, canned-response draft), `LAUNCH-CHECKLIST.md`.
- CI: deploy-to-staging on `main`, deploy-to-production on `v*` tags behind a reviewer, 15-minute uptime check, weekly encrypted `pg_dump` to R2. `pnpm db:roundtrip` (up → full rollback → re-apply → identical schema).
- `[observability]` (Workers Logs) enabled in `wrangler.toml`.
- **Module 1 — auth & devices.** `POST /v1/auth/session`, `GET /v1/me`, `GET /v1/devices`, `DELETE /v1/devices/:deviceId`. Firebase ID-token verification, 2-device rule with silent eviction, remote sign-out. Migration `0001`.
- **Module 2 — legal gate, onboarding, applicants.** `/v1/legal/*`, `PATCH /v1/onboarding/applicant-count`, `GET /v1/reference/relationships`, `/v1/applicants` CRUD + `PATCH /v1/applicants/:id/stage`. Migration `0002`.
- Migration `0004` — drops `users_email_lower_uq`; email is no longer unique (identity is `firebase_uid`). Fixes 500 on re-signup after Firebase account deletion. Rollback fails if duplicate live emails exist (see `.down.sql`).
- Migration `0003` — covering indexes for `applicants.relationship_code` and `legal_acceptances.legal_version_id`.
- Tooling: `scripts/migrate.mjs` (up/down/status, checksum-guarded; `pnpm db:status`), `scripts/preflight.mjs` (production deploy gate), CI workflow, Docker Compose Postgres, Dependabot, PR/issue templates.
- Claude Code: `.claude/commands/` (`/new-module`, `/migration`, `/gate-check`, `/security-review`), `.claude/settings.json` deny rules for secrets and production deploys; `apps/mobile/CLAUDE.md`.
- Process docs: `TESTING.md` (five gates), `SECURITY.md`, `SCALE.md`, plus `INDEX`, `ARCHITECTURE`, `API-CONTRACT`, `DATA-MODEL`, `ENVIRONMENTS`, `DEPLOYMENT`, `RUNBOOK`, `OBSERVABILITY`, `DATA-PRIVACY`, `ROADMAP`, `GLOSSARY`, `MODULE-TEMPLATE`, `FLUTTER-ARCHITECTURE`, and ADRs 0001–0011.

- **Module 3 — checklist engine.** `GET /v1/applicants/:id/checklist`, `GET /v1/applicants/:id/journey`, `GET|PATCH /v1/checklist/:id`, `POST /v1/checklist/:id/acknowledge-review`; free-tier preview (3 items + `lockedCount`), offline conflict detection (`baseVersion` / `clientMutationAt`), delta sync (`since`), keyset pagination. Migration `0005` (`sources`, `source_flags`, `requirements`, `applicant_requirements`, `app_config['checklist']`). New codes `PREMIUM_REQUIRED` (402), `CHECKLIST_CONFLICT` (409). `Applicant.readiness` added (additive) — non-breaking. `generateCase()` is real and sets `case_generated_at`; changing category / location / DOB / Nulla Osta status now recomputes applicability in the same transaction.
- `pnpm gate4` + `seed/seed_load.sql` (30k users, 75k applicants, 1.9M checklist rows); `seed/seed_dev_requirements.sql` (placeholder, blocked from launch by `preflight`).

- **Module 3c — Eligibility Quick Check.** Public `GET|POST /v1/public/eligibility-check`; migration `0006` (`eligibility_check_versions`); one shared applicability definition for case generation and the Quick Check; `copy-rules.json` + preflight guard on verdict language and placeholder copy.

### Fixed
- `createDb` now awaits `client.connect()`; previously every query hung.
- `POST /v1/auth/session` on a deleted account returns `USER_DELETED` (403) without rewriting PII.
- `X-Request-Id` response header on every response.

### Changed
- `GET /v1/me` is its own router (was drafted as `/v1/auth/me`). No client existed, so not breaking.
- Dev placeholder disclaimer moved out of migration `0002` into `apps/api/seed/seed_dev_legal.sql`. **Existing dev databases must be recreated** (the migration checksum changed). Nothing was deployed.

### Fixed
- **Security:** `FIREBASE_AUTH_EMULATOR_HOST` is now ignored unless `ENVIRONMENT === 'development'` (`libraryEnv()` in `lib/firebase.ts`), and `pnpm preflight` fails a deployed env whose config declares it.
- `pnpm preflight` takes `--env staging|production` and checks only that environment's `wrangler.toml` block.
- `verifyIdToken` was called with `env` in the `checkRevoked` position, which would have enabled Firebase revocation checks on every request. Now `verifyIdToken(jwt, false, env)`.
- `Db` type now accepts transaction handles, so services can run inside `db.transaction()`.
- Config fallbacks aligned with the values seeded by `0002` (`max_applicants: 10`, `expiry_warning_days: 30`).
- **Restored Module 2 session code** that the repo had silently reverted to Module 1 versions: `GET /v1/me` and `POST /v1/auth/session` again return `legal`, `applicants` and `entitlement.graceApplicantIds`, computed in one statement (`loadMeSnapshot`). Entitlement is real (premium / grace / expired bucketed against `now()`), no longer a stub. Drizzle `users` schema regains `declaredApplicantCount`.
- Error code `ONBOARDING_STEP_REQUIRED` (introduced during the reconstruction) renamed back to the Module 2 contract value **`ONBOARDING_STEP_INVALID`** (409). No client shipped with the wrong name.
- HTTP status for each error code now comes from one table (`STATUS_BY_CODE`), compiler-checked against `ErrorCode`.
- `wrangler.toml`: production/staging environments declared no Hyperdrive/KV bindings (Wrangler does not inherit them), so `--env production` would have deployed a Worker that 500s every `/v1` call. Bindings now declared per env; CI asserts them. Bare `deploy` script removed.

### Known gaps
- `GET /v1/applicants` is not paginated — bounded by `app_config.onboarding.max_applicants`; documented exemption in `API-CONTRACT.md`.
- No rate limiting in code (edge WAF rule, pre-launch).
