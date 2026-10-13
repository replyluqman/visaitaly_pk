# 0010 — Checklist engine data design (Module 3)
Status: Accepted — build proceeded on the owner's instruction to complete per PRD; revisit by superseding ADR | Date: 2026-10

## Context
Case generation runs on the Screen 7 request path inside the stage transaction and
must fit the CPU budget. Requirements are CMS content that changes over time.

## Decision
1. Migration 0005 creates `requirements` + `applicant_requirements` with the final
   read shape, so the later CMS migration is purely additive.
2. Applicability is declarative columns (category, stage, location, …), not a JSONB
   rule blob — generation is one `INSERT … SELECT`.
3. Store 4 statuses + `is_applicable`; `not_applicable` is derived on read, so an
   edit that flips a requirement out and back keeps progress.
4. Requirement rows update in place with an incrementing `version` int; user rows FK
   the stable requirement id.
5. Requirement definitions live in `seed/` (ADR 0007).

## Resolved
PRD v3.1 §12: 5 display statuses (4 stored + derived `not_applicable`), 3 badges (`blocking`, `needs_review`,
`source_under_review`). Implemented in `apps/api/MODULE-03-CHECKLIST.md`.
