# 0007 — Content never ships in migrations; `preflight` enforces
Status: Accepted | Date: 2026-10

## Context
Placeholder legal text in migration 0002 would reach production automatically and
satisfy the "legal version exists" check that is meant to block launch.

## Decision
Real or placeholder content (legal text, requirement definitions, copy) lives in
`apps/api/seed/` and is applied by hand per environment, or published via CMS.
Config defaults (`app_config`, `relationships`) are schema-adjacent and stay in
migrations. CI greps migrations for content inserts; `pnpm preflight` fails a
production deploy on draft legal text.

## Consequences
A fresh production database has no legal text and the app correctly blocks at the
Disclaimer Gate until real text is published.
