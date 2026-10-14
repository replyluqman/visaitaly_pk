# Module 10b — Pricing/CMS config editor + Admin overview

## 1. Purpose
PRD §6 "zero hardcoding" made operable (Screen 43, scope `pricing_config`) and the admin landing page (Screen 31) so SLA breaches are visible internally.

## 2. Scope
In: `GET /v1/admin/overview`, `GET /v1/admin/config`, `PUT /v1/admin/config/:key`; strict per-key schemas in `@visaitaly/shared` (`config.types.ts`). No migration.
Out: price keys (Premium/Appointment/translation/courier prices, referral credit, grace, renewal duration, Urdu-complete flag) — they arrive with Modules 6/7/9 and the O1 currency decision; adding one = a schema entry in `CONFIG_SCHEMAS` + its fallback. Refund / renewal / payout lookups and overview sections for them arrive with those modules.

## 3. Contract
`GET /config` → `{items:[{key,value,isDefault,description,updatedBy,updatedAt}]}` (pricing_config | read_only | super).
`PUT /config/:key {value}` → the updated entry (pricing_config | super). `GET /overview` → `{support?, verification?, legal?, privacy?}` (any active admin; each section only for its scope, read_only, or super; privacy: read_only/super).
No new error codes (422 `VALIDATION_FAILED`, 403 `ADMIN_FORBIDDEN`). No breaking changes.

## 5. Decisions
1. **Strict allow-list, not a free key/value store.** Only the 12 keys the code reads can be written; each has a strict zod schema with bounds (an unknown field, a wrong type, `max_active_devices: 0` are 422). A key outside the list is 422 — the endpoint cannot be used to plant arbitrary settings.
2. **PUT replaces the whole value**; the new value is validated in full, so the stored row can never drift from what `readConfig` expects. The `readConfig` fallbacks stay as the safety net for a missing row.
3. **Audit before + after** in the same transaction (`config.update`, target = key). Config holds no personal data, so values are safe to record; the row is locked `FOR UPDATE` so before/after are consistent.
4. **Copy is screened.** `sla.working_hours_text` gets the same verdict-phrase check as support replies and CMS copy; English is required when present.
5. **Overview shows absence, not zero, for unbuilt modules** — a zero would read as "all clear" on the screen meant to enforce the SLA promise. Sections are scoped; privacy requests (no scope of their own, handled by Cron) are for super / read_only only.
6. **No optimistic concurrency** (last write wins, both audited). Two admins editing the same key at once is unlikely with a handful of admins; add an `expectedUpdatedAt` check if it ever bites.

## 8. Test results
**317 tests green** (`config-admin.test.ts` 12). No migration, so no round-trip needed.

| Gate | Result |
|---|---|
| 1 Static | typecheck clean; wrangler bundles (1077 KiB / 209 KiB gz) |
| 2/3 | list incl. default rows; scope matrix (pricing_config / read_only / other / anonymous); replace + audit before/after; row created when absent; strict validation (8 bad shapes, unwrapped body, unknown key) leaves the row and audit log untouched; copy screening; overview scoping (support-only, verification-only, super/read_only all, none), breach counting, unreachable-source threshold from config, 401/403 |
| 4 | overview aggregates 0.01–0.05 ms, config list 0.02, row lock 0.01 (all index-driven; `pnpm gate4` passes) |
| 5 | scope enforced by `requireAdmin` on every route; bounded values; copy screened; every write audited; no user data touched. **Open:** a super-admin can change any key — by design; consider two-person approval for pricing once prices exist |

## 9. Not verified here
Nothing external. Price keys cannot be exercised until Module 6.
