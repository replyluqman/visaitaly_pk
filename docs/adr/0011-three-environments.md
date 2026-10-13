# 0011 — Three environments with per-env bindings
Status: Proposed — re-confirm | Date: 2026-10

## Context
Wrangler does not inherit bindings into `[env.*]`. The earlier config deployed a
production Worker with no database binding. There was no place to exercise the real
runtime before production.

## Decision
development (top level, never deployed), `staging`, `production` — each declares its
own vars, Hyperdrive and KV. Separate Firebase project per env. No bare
`wrangler deploy` script. CI bundles every env and asserts both bindings.

## Consequences
Two extra Firebase/Neon-branch/KV setups (free). Staging data is synthetic only.
