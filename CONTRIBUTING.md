# Contributing

Applies to everyone who changes this repo — people and Claude Code alike. The rules below are the short version; `CLAUDE.md` holds the invariants and `docs/TESTING.md` the gates.

## Workflow

- **Trunk-based.** `main` is always deployable. Work on short-lived branches (`feat/…`, `fix/…`, `chore/…`, `docs/…`) and merge by PR. No direct pushes to `main`.
- **One module at a time.** Do not start Module N+1 until Module N has passed every gate in `docs/TESTING.md` and its doc records the results.
- **Small PRs.** One concern per PR. A migration never shares a PR with unrelated work.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/) — `feat(checklist): …`, `fix(auth): …`, `docs: …`. The scope is the module name.

## Before you open a PR

```bash
pnpm typecheck          # Gate 1 — must be clean, not "clean except"
pnpm db:migrate && pnpm db:rollback && pnpm db:migrate   # if you touched migrations
```

CI repeats this against a throwaway Postgres and additionally bundles the Worker, audits foreign-key indexes, and rejects edits to already-applied migrations.

## Rules that are enforced, not suggested

| Rule | Where it is enforced |
|---|---|
| Never edit or delete an applied migration — add a new one | `scripts/migrate.mjs` checksum; CI diff check |
| Every migration ships a tested `.down.sql` | CI up → down → up cycle |
| Every foreign key has a covering index | CI audit query; `pnpm preflight` |
| No real content (legal text, requirement copy) inside a migration | CI grep; `pnpm preflight` blocks draft legal text |
| No secrets in `wrangler.toml` | `pnpm preflight` |
| Every user-owned query filters by `userId` **in SQL** | Code review + cross-user 404 test (Gate 3) |
| List endpoints paginate by cursor, never `OFFSET` | Gate 4 review |
| `any`, `dynamic`, non-null `!` on API data — not in new code | Gate 1 review |

## Adding a module

1. Copy `docs/MODULE-TEMPLATE.md` to `apps/api/MODULE-0N-<name>.md` and fill in purpose, endpoints, decisions **before** writing code. If a decision is open, ask — do not invent requirements.
2. Add a migration pair (`NNNN_name.sql` + `NNNN_name.down.sql`). Declare retention in the same migration for any append-only table.
3. Shared types and zod schemas go in `packages/shared/src`. New error codes go in `errors.ts` **and** must be mirrored in the Flutter client.
4. Service holds logic + SQL + authorisation; route holds HTTP only.
5. Update `docs/API-CONTRACT.md` and `docs/DATA-MODEL.md` in the same PR. A PR that changes either without touching the doc is incomplete.
6. Record gate results in the module doc, then update `STATE.md` and `CHANGELOG.md`.

## Breaking changes

API changes are additive by default. A change that removes or reshapes a field the shipped app reads is **breaking**: flag it in the PR title, state the migration path for the client in the PR body, and see the deprecation policy in `docs/API-CONTRACT.md`. Android users on old app versions are the reason this matters — the Play Store does not let us force an instant update.

## Security issues

Do not open a public issue for a vulnerability or for anything involving user documents. Tell the repo owner directly. (A formal disclosure contact is an open item — `docs/ROADMAP.md`.)

## Help

If you are unsure about a library version, an API signature or a platform limit: **verify, do not guess.** `apps/api/src/lib/firebase.ts` is the cautionary example — a wrong argument position silently enabled per-request revocation checks.
