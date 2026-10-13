# 0010 — Checklist engine data design (Module 3)
Status: Proposed — agreed in discussion without explicit objection; **re-confirm before 0004 is written** | Date: 2026-10

## Context
Case generation runs on the Screen 7 request path inside the stage transaction and
must fit the CPU budget. Requirements are CMS content that changes over time.

## Decision
1. Migration 0004 creates `requirements` + `applicant_requirements` with the final
   read shape, so the later CMS migration is purely additive.
2. Applicability is declarative columns (category, stage, location, …), not a JSONB
   rule blob — generation is one `INSERT … SELECT`.
3. Store 4 statuses + `is_applicable`; `not_applicable` is derived on read, so an
   edit that flips a requirement out and back keeps progress.
4. Requirement rows update in place with an incrementing `version` int; user rows FK
   the stable requirement id.
5. Requirement definitions live in `seed/` (ADR 0007).

## Open
PRD §12 lists 5 statuses; confirm the exact set and the badge list before migration.
