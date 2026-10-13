# Module 03 — Checklist engine

## 1. Purpose
Turns an applicant's profile into a personalised case file (PRD §12–13, Screens §10–12): requirements instantiated
per applicant at Screen 7, five display statuses, three badges, non-applicable items shown with their reason, free
tier preview (3 items + locked count), offline-safe status updates with conflict detection, and the stage timeline.
Fills the `generateCase()` stub; sets `applicants.case_generated_at`.

## 2. Scope
In: `sources`, `source_flags`, `requirements`, `applicant_requirements` (migration 0005); case generation; checklist
list / detail / patch / acknowledge-review; journey; `readiness` on `Applicant`.
Out: R2 documents (3b — `documentCount` is `0` until then), requirement authoring + hash cron + notifications (4/5),
Eligibility Quick Check (3c, after the core passes its gates), `next_actions` (3b).

## 3. Contract
| Method | Path | Success | Errors |
|---|---|---|---|
| GET | `/v1/applicants/:id/checklist?since&status&blocking&translation&apostille&cursor&limit` | `ChecklistResponse` | 404, 422 |
| GET | `/v1/checklist/:id` | `ChecklistItemDetail` | 402 `PREMIUM_REQUIRED`, 404 |
| PATCH | `/v1/checklist/:id` `{status, baseVersion?, clientMutationAt?}` | `ChecklistItem` | 402, 403 `APPLICANT_READ_ONLY`, 404, 409 `CHECKLIST_CONFLICT`, 409 `CONFLICT` (not applicable), 422 |
| POST | `/v1/checklist/:id/acknowledge-review` | `ChecklistItem` | 402, 403, 404 |
| GET | `/v1/applicants/:id/journey` | `JourneyResponse` | 404 |

New error codes (neither session-terminal): `PREMIUM_REQUIRED` 402, `CHECKLIST_CONFLICT` 409.
Additive change to `Applicant`: `readiness {percent, applicableCount, readyCount, blockingCount, notApplicableCount,
categorySpecificCount}`. Breaking changes: **none**.

## 4. Data — migration `0005_checklist_engine`
`sources`, `source_flags`, `requirements`, `applicant_requirements` as in `docs/ERD.md` §Module 3, plus
`requirements.stage_order` (generated from `stage`, so ordering is an index, not a `CASE`) and
`app_config['checklist'] = {free_preview_items: 3}`. `last_verified_by` / `resolved_by` carry no FK until the admin
table exists (Module 10), as `published_by` does today. No content in the migration (ADR 0007); dev content in
`seed/seed_dev_requirements.sql`. Rollback = drop in reverse order (no existing column touched → expand-only).

## 5. Decisions (ADR 0010 confirmed by the owner's instruction to proceed; flagged here so it can be revisited)
1. **Generation = one `INSERT … SELECT … ON CONFLICT`** inside the stage transaction. Rows exist for *every*
   published requirement, applicable or not; `is_applicable` is recomputed on conflict so progress survives a flip.
2. **Applicability** is evaluated server-side from category, location, Nulla Osta status and age. Unknown DOB never
   excludes an item (we would rather show than hide something required).
3. **Free preview** = first `free_preview_items` *applicable* items in (stage, sort) order; non-applicable items are
   not part of the free response. `lockedCount` = applicable items beyond the cap. Detail/patch on a locked item → 402.
   Free users may write to visible items (invariant 7).
4. **Conflict (PRD §12):** a patch carrying `baseVersion ≠ requirements.version`, or a `clientMutationAt` older than
   the row's `status_updated_at`, is **not applied**; `needs_review` is set (persisted) and `CHECKLIST_CONFLICT` returned.
5. **Pagination deviation:** keyset on `(stage_order, sort_order, id)` rather than `(created_at, id)` — the list's
   natural order is journey order. Still no `OFFSET`; cursor is opaque and validated.
6. `not_applicable` is derived (`NOT is_applicable`), never stored; the 4 stored statuses are writable.
7. `documentCount` is a constant `0` until Module 3b adds `documents`; the field is in the contract now so the
   Flutter model does not change later.

## 6. Verify (manual)
See the integration suite `test/checklist.test.ts`; manual: seed with `seed/seed_dev_requirements.sql`, create an
applicant with `currentStage`, `GET /v1/applicants/:id/checklist` (expect 3 items + `lockedCount` for a free user).

## Test results

**Date:** Phase 2 · **DB:** Postgres 16, migrations 0001–0005 · `apps/api/test/checklist.test.ts` (32 tests; 98 total, all green)

| Gate | Result |
|---|---|
| 1 Static | `pnpm typecheck` clean (src + tests + shared); `wrangler deploy --dry-run` bundles all 3 envs (887 KiB / 168 KiB gz) |
| 2 Unit | Every code: `PREMIUM_REQUIRED`, `CHECKLIST_CONFLICT`, `APPLICANT_READ_ONLY`, `CONFLICT`, `NOT_FOUND`, `VALIDATION_FAILED`. Access branches: free (cap, config-driven), premium, grace, expired. Applicability: category ×3, location, age (incl. unknown DOB), Nulla Osta status, flip-out-and-back preserves progress. Invariants 8 (derived readiness / `not_applicable`) and 10 (generation atomic with the stage write — forced failure rolls back stage, event and case) |
| 3 Integration | Generation idempotent; draft requirement excluded; journey order; filters (status, blocking, translation, apostille); keyset pagination walks 10 items in 4 pages exactly once; bad cursor/limit/status/since/blocking → 422; delta sync incl. requirement edits (version bump → `requirementVersion 2`); `source_under_review` badge follows an open flag; offline conflict (stale `baseVersion`, stale `clientMutationAt`) → not applied, `needs_review` persisted across the error, cleared by acknowledge; journey states; readiness counts; **cross-user 404 on checklist, journey, item GET / PATCH / acknowledge**, same message as a missing id, victim row unchanged; a free B gets 404 (not 402) for A's locked item; 401 and 422 on ids |
| 4 Query & load | `pnpm gate4` at 30k users / 75k applicants / **1.875M applicant_requirements**: list (free) 0.23 ms, list (keyset) 0.15 ms, delta 0.15 ms, locked count 0.02 ms, ownership lookup 0.03 ms, lock-for-write 0.05 ms, status update 0.26 ms, journey 0.06 ms, case generation 0.16 ms, readiness lateral 0.11 ms. No Seq Scan >10k rows. Detector verified with a negative control (indexes disabled → 21 FAILs). Statements per request are constant in item count: list = 2 (premium) or 4 (free: + cap config + locked count); detail = 3–4; patch = 3–5 in the transaction + the detail re-read. **Not measured:** Worker CPU (needs staging) |
| 5 Security | below |

### Security checklist
- [x] Every read/write filters `user_id` in SQL (`ar.user_id`, `a.user_id`); no fetch-then-check
- [x] Cross-user → 404, tested on all 5 routes; locked-vs-absent is not distinguishable to a non-owner
- [x] Access level enforced in the service (`assertWritable`, `assertVisible`); free cap cannot be widened by filters, cursor or `since` (tested)
- [x] All query/body/param input through zod; `limit ≤ 50`, `cursor ≤ 200` chars and structurally validated, `baseVersion`/timestamps bounded
- [x] Derived fields (`readiness`, `status` display, badges, `lockedCount`) are server-computed; no client-supplied value is stored except the 4-value status
- [x] Concurrent writes serialised with `FOR UPDATE OF ar`
- [x] No PII added to logs; no IP stored
- [x] No content in the migration; dev content only in `seed/seed_dev_requirements.sql`, blocked from launch by `preflight`
- N/A: uploads (3b), admin endpoints (4)

### Decisions to revisit
- An **expired** (post-grace) applicant sees the full checklist read-only, as for grace. PRD §7 only specifies grace; say if expired should fall back to the free preview.
- Publishing a new requirement must fan out to existing applicants — **Module 4** owns this (the `requirement_id` index exists for it).
