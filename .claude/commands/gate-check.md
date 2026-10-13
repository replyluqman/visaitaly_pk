---
description: Run and report the five test gates for a module
argument-hint: <module number>
---

Run the gates from `docs/TESTING.md` for Module $ARGUMENTS and report honestly.

1. G1: `pnpm typecheck`; bundle each env (`wrangler deploy --dry-run --env <env>`) and
   confirm both bindings appear.
2. G2/G3: run the test suites that exist. For every id-taking route of the module,
   confirm a cross-user test asserts 404. List routes lacking one.
3. G4: against a local DB seeded to 30k-user volume, `EXPLAIN (ANALYZE, BUFFERS)` each
   module query. Flag any Seq Scan on a user-owned table. Run the FK-cover query.
4. G5: walk `docs/SECURITY.md` per-module checklist; answer every item yes/no/n.a.
   with evidence (file:line or command output).
5. Migrations: up → down → up.

Output a table: gate | pass/fail | evidence. Executed results only — never mark a
gate passed that was not actually run. Then update the module doc §8 and `STATE.md`.
