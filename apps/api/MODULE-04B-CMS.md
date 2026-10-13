# Module 04b — CMS & verification workflow

## 1. Purpose
PRD §13 + Screens §39/§40/§15: author requirements with a **verification record**, publish them so they reach users' cases, detect when an
official source changes (daily hash sweep), show users that a source is under review, and expose the trust surface (How We Verify).
Builds on Module 4a (admin identity, scopes, audit).

## 2. Scope
In: migration `0009`; `/v1/admin/sources|requirements|source-flags`; workflow Created → Verified → Published (+ unpublish, archive, re-verify);
publish **fan-out** to existing cases; hash-sweep Cron job; `GET /v1/public/verification-summary`; "only published is visible" across all user queries.
Out: the CMS web UI; the **Updates notification** on publish (Module 5 reads `requirement_versions`); CSV import tool.

## 3. Contract (all admin routes: scope `verification_manage`; read also by `read_only`/super)
| Method | Path | Notes |
|---|---|---|
| GET/POST/PATCH | `/v1/admin/sources[/:id]` | https-only unique URL, locale-keyed name, authority; deactivate with `isActive:false` |
| GET | `/v1/admin/source-flags?status&cursor&limit` | each with `affectedRequirements` |
| POST | `/v1/admin/source-flags/:id/resolve` `{action: reverified\|dismissed, note?}` | `reverified` re-stamps every published requirement of that source |
| GET/POST | `/v1/admin/requirements` | list in catalogue order (keyset on stage, sort, id) |
| GET/PATCH | `/v1/admin/requirements/:id` | PATCH on a **published** row needs `reverify:true` + `changeSummary` |
| GET | `/v1/admin/requirements/:id/versions` | published-version history |
| POST | `/v1/admin/requirements/:id/actions` `{action: verify\|publish\|unpublish\|archive\|reverify, changeSummary?}` | |
| GET | `/v1/public/verification-summary?locale` | no auth, `max-age=300` |

No new error codes (uses 403 `ADMIN_FORBIDDEN`, 404, 409 `CONFLICT`, 422). Breaking changes: **none** for shipped clients; internal: `version` semantics (see 5.4).

## 4. Data — `0009_cms_workflow` (expand-only; rollback restores the exact previous schema incl. the 0005 trigger body)
`requirement_versions` (append-only by trigger; unique `(requirement_id, version)`), `sources.last_error / consecutive_failures`, the two FKs onto `admins`
deferred from 0005 (`NOT VALID` + `VALIDATE`, all values NULL), `requirements_status_idx`, `app_config['verification']`. Retention: `requirement_versions` forever.

## 5. Decisions
1. **States:** `created → verified → published`; `unpublish` returns to `verified`; `archive` is final; `reviewed` (in the CHECK) is reserved and unused —
   a periodic re-check is the **`reverify`** action (re-stamps, no version bump) so a re-checked requirement never drops out of cases.
2. **A published requirement can't change without its verification record** (PRD §13): PATCH requires `reverify:true` and a user-facing `changeSummary`;
   one transaction applies the edit, re-stamps verifier+time, bumps `version`, snapshots it, and fans out. Editing a *verified* requirement un-verifies it.
3. **Fan-out** (the gap Module 3 left): publish/re-publish runs `reconcileRequirement` — one set-based INSERT … ON CONFLICT over every active applicant that has a
   case. New row per applicant, or `is_applicable` recomputed; **progress is never touched**; `seen_requirement_version` is left alone so offline edits made against
   the old version surface as `CHECKLIST_CONFLICT`. Applicants without a case get theirs at Screen 7.
4. **`version` counts published revisions only** (trigger replaced in 0009): drafting edits don't bump it, so the first publication is v1 and clients' `baseVersion` is meaningful.
5. **Only `published` is visible to users** — checklist, detail, patch, journey, readiness, Today; unpublish/archive hides, republish restores with progress intact.
6. **Hash sweep** (runs every 5-minute tick but only touches sources unchecked for `verification.recheck_after_hours` = 20, so each source is checked about daily; Module 5 consolidated the crons): oldest-checked active sources, `hash_sweep_batch` per run (free tier: 50 subrequests/invocation).
   HTML is reduced to visible text before hashing (scripts/styles/comments/whitespace ignored), PDFs are hashed byte-exact. First sight = baseline, not a change.
   One open flag per source (a second change moves `new_hash`). A **failed fetch never looks like a change**: hash untouched, `consecutive_failures++`, `last_error` shown to admins.
   We store only a hash — never page content. Known limit: pages with dynamic *visible* text can raise false flags; an admin dismisses them.
7. Audit metadata carries ids and field **names**, never values.

## 8. Test results
**204 tests green** (`cms.test.ts` 31). Round-trip: 9 migrations, identical schema.

| Gate | Result |
|---|---|
| 1 Static | typecheck clean; wrangler bundles 3 envs |
| 2/3 | scopes (anonymous 401, user token 401, other-scope 403, `read_only` reads/never writes, scoped + super write); source & requirement validation, duplicates, unknown source; catalogue-order list + keyset; the full workflow incl. every illegal transition; published-edit protection (409/422), re-verify, version history + append-only; audit trail; atomicity; **fan-out** (existing cases get the row, case-less don't, applicability flips preserve progress, offline conflict after a version bump); **visibility** (unpublish/archive hides in 5 places, republish restores); flags (list, reverified re-stamps, dismissed doesn't, double-resolve 409); sweep (baseline, noise ignored, change → one flag, system audit, failure ≠ change, counters, inactive skipped, batch bounded, PDFs, normaliser); How We Verify (counts, %, last sweep, open flags, recent updates, empty catalogue) |
| 4 | publish fan-out across **75,000 applicants: 1.4 s** (re-publish, conflict path; admin action, inherently a scan of `applicants`); sweep selection 0.03 ms; list 0.07 ms; summary 0.05 ms. Cron refresh (Today) unchanged: ~2.8 s / 15k. 44 queries pass |
| 5 | admin scope enforced in middleware; no content stored from sources (hash only); outbound fetch is https-only to admin-entered URLs with timeout + size cap; audit append-only; **open:** rate limiting (edge); first-ever sweep against real sites happens on staging |

### Found by the tests
- Drafting edits inflated `version` (first publication was "v2"); fixed by redefining the trigger (above).
- `TRUNCATE … CASCADE` on `admins` in the load seed now cascades to `requirements` (new FK) — seed reordered.
