# Deployment

Order is fixed: **migrate → preflight → deploy → smoke**. Database first, because
every migration is expand-only or backward compatible with the running Worker
(`SCALE.md` §4). A migration that the *old* Worker cannot run against is a bug in
the migration plan, not a deployment problem.

## Staging

```bash
export DATABASE_URL="<Neon staging branch DIRECT url>"   # never the Hyperdrive url
pnpm db:status
pnpm db:migrate
pnpm preflight --env staging
pnpm api:deploy:staging
curl -s https://<staging-worker-host>/health               # {"ok":true}
```

Then run the Flutter app (staging flavor) through: sign in → `/v1/me` → disclaimer →
add applicant → set stage. That is the release smoke test until Gate 3 is automated.

## Production

Preconditions: the same commit is green in CI and has been on staging.

```bash
export DATABASE_URL="<Neon main DIRECT url>"
pnpm db:status                      # read what will apply
pnpm db:migrate
pnpm preflight --env production     # must exit 0
pnpm api:deploy:production
curl -s https://<prod-worker-host>/health
wrangler tail --env production      # watch 5 minutes: no 500s, CPU well under 10 ms
```

Never `wrangler deploy` without `--env` — it ships the development block.
There is deliberately no script for it.

### Preflight is environment-scoped

`pnpm preflight --env staging|production` checks only that environment's `wrangler.toml` block (placeholders, a
declared emulator variable, committed secrets) plus database state (unapplied migrations, draft legal text, FK
cover). Dev placeholders no longer block a production deploy.

### CI does this for you

Push to `main` → CI → staging (migrate → preflight → deploy → `/health` smoke). A `v*` tag → production, behind the
`production` GitHub Environment's required reviewer. The manual commands above remain for emergencies.
Flow, secrets and DR: `ENVIRONMENTS.md`.

## Neon safety net

Before a production migration that touches existing data (backfill or contract),
create a Neon branch of `main` named `pre-<migration>-<date>`. It is an instant
copy-on-write snapshot and the fastest restore path. Delete it after a week.

## Rollback

| What broke | Do |
|---|---|
| Worker code | `wrangler rollback --env production` (previous version) or redeploy the previous commit. DB untouched. |
| An expand migration | Usually leave it — the old Worker ignores new nullable columns. If it must go: `pnpm db:rollback` (runs its `.down.sql`). |
| A backfill / contract migration | Restore from the pre-migration Neon branch, or `.down.sql` if it is non-destructive. Decide before running, not after. |

Verify `wrangler rollback` behaviour against the installed wrangler version before
relying on it.

## Release hygiene

- Version the Worker with the git SHA (`wrangler deploy --var GIT_SHA:<sha>` or tag
  the commit) so a log line maps to code. *(Not wired yet.)*
- Update `CHANGELOG.md` under the version, move items out of `Unreleased`.
- Mobile releases go through Play internal → closed → production tracks; the API
  must support the oldest app version still in use (additive changes only on `/v1`).
