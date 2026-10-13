# VisaItaly PK

Paid mobile app that guides Pakistani applicants (and the family members managing their cases) through the **Italy Family Reunification Visa** journey. Android first, iOS later.

> This repo is the **backend + shared contract**. The Flutter app lives in `apps/mobile` (not started — see `docs/FLUTTER-ARCHITECTURE.md`). The CMS admin (`apps/cms`, Next.js on Cloudflare Pages) is reserved in `pnpm-workspace.yaml` and not started.

Product spec: `docs/VisaItalyPK-PRD-v3_1.md` (locked) · Screens: `docs/VisaItalyPK-Screens-v2.md` · Everything else: `docs/INDEX.md`.

## Stack

Cloudflare Workers (Hono) · Neon Postgres via Hyperdrive (`pg` + Drizzle) · Firebase Auth (identity only) · R2 · Cron Triggers · FCM · Flutter · pnpm workspaces. Locked in PRD §4 — see `docs/adr/` for the reasoning, not for re-litigation.

## Repo map

```
apps/api/            Cloudflare Worker — HTTP API, migrations, scripts
apps/mobile/         Flutter app (not started; CLAUDE.md only)
apps/cms/            Admin CMS (not started)
packages/shared/     zod schemas, types, error codes — imported as @visaitaly/shared
docs/                spec, architecture, contracts, runbooks, ADRs
.claude/commands/    Claude Code slash commands for this repo
```

## Quick start

Prerequisites: Node 22 (`.node-version`), pnpm 9, Docker, `psql`.

```bash
pnpm install

# 1. local Postgres on :5433 (stands in for Neon)
docker compose up -d db
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/visaitaly

# 2. schema + dev-only seed (legal placeholder text is NOT in the migrations)
pnpm db:migrate
psql "$DATABASE_URL" -f apps/api/seed/seed_dev_legal.sql

# 3. run the Worker
cp apps/api/.dev.vars.example apps/api/.dev.vars
export WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$DATABASE_URL"
pnpm api:dev
```

`GET http://localhost:8787/health` → `{"ok":true}`. Authenticated routes need a Firebase ID token — see `docs/ENVIRONMENTS.md` for the local emulator setup.

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` across all workspaces (Gate 1) |
| `pnpm db:migrate` | Apply pending migrations (needs `DATABASE_URL`, a **direct** connection — never Hyperdrive) |
| `pnpm db:rollback` | Roll back the most recent migration via its `.down.sql` |
| `pnpm db:status` | Applied vs pending |
| `pnpm preflight` | Production deploy gate — fails on unset bindings, committed secrets, draft legal text, uncovered FKs |
| `pnpm api:dev` | `wrangler dev` |
| `pnpm api:deploy:staging` / `:production` | `wrangler deploy --env …` — run `pnpm preflight` first (`docs/DEPLOYMENT.md`). There is deliberately no bare `deploy`: it would ship the development config. |

## How work gets done here

1. Read `CLAUDE.md` (engineering brief, invariants) and `docs/TESTING.md` (the five gates).
2. One module at a time. A module is not done until every gate passes and its `MODULE-0N` doc records the results. The next module does not start before that.
3. Schema changes are expand → backfill → contract, each its own migration with a tested `.down.sql`.
4. Status lives in `STATE.md` and `docs/ROADMAP.md`, not here — this file should not go stale.

Private repository. All rights reserved.
