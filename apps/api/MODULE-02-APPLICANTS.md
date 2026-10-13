# Module 2 — Legal Gate + Applicant Profiles + Onboarding

Covers PRD §2 (account model, relationship categories), §6 (zero hardcoding),
§7 (premium lifecycle columns, grace write-gate), §11 (onboarding), §12 (journey
stages), §14 (Nulla Osta tracking), §18 (disclaimer version stamping), §19
(data minimisation); Screens §4 Disclaimer Gate, §5 Applicant Count,
§6 Profile Setup, §7 Stage Select, §10 Applicant Case View, §29 Settings, §44
Legal Version Manager.

## Endpoints

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/v1/legal/current` | token + device | Current versions + acceptance state. No bodies. |
| GET | `/v1/legal/current/:docType` | token + device | Full text for one document (Screen 4). |
| POST | `/v1/legal/accept` | token + device | Version-stamped blocking accept. Advances onboarding. |
| PATCH | `/v1/onboarding/applicant-count` | token + device | Screen 5 selector. Declared intent. |
| GET | `/v1/reference/relationships` | token + device | CMS-driven relation picker for Screen 6. |
| GET | `/v1/applicants` | token + device | Dashboard source. |
| POST | `/v1/applicants` | token + device | Create profile (Screen 6). |
| GET | `/v1/applicants/:id` | token + device | Case View header. |
| PATCH | `/v1/applicants/:id` | token + device | Profile corrections. Not the stage. |
| PATCH | `/v1/applicants/:id/stage` | token + device | Screen 7. Seeds the journey engine. |
| DELETE | `/v1/applicants/:id` | token + device | Soft delete. |

All routes accept `?locale=xx` for display labels only. Urdu content is gated by
PRD §11a, so `en` is the only populated locale today; unknown locales fall back
per document rather than 404ing.

## Mount these in `src/index.ts`

```ts
import { legalRoutes } from './modules/legal/legal.routes.js';
import { onboardingRoutes } from './modules/onboarding/onboarding.routes.js';
import { referenceRoutes } from './modules/reference/reference.routes.js';
import { applicantRoutes } from './modules/applicants/applicants.routes.js';

app.route('/v1/legal', legalRoutes);
app.route('/v1/onboarding', onboardingRoutes);
app.route('/v1/reference', referenceRoutes);
app.route('/v1/applicants', applicantRoutes);
```

## Breaking changes in this module

1. **`packages/shared/errors.ts` gains 4 codes.** `apps/api/src/lib/errors.ts`
   holds an exhaustive `Record<ErrorCode, …>`, so **both files must be replaced
   together or the build fails.** The new codes are deliberately absent from
   `SESSION_TERMINAL_CODES` — they are recoverable in place, not a logout.
2. **`MeResponse` gains `legal` and `applicants` blocks; `Entitlement` gains
   `graceApplicantIds`.** Additive for Flutter, but `auth.service.ts` is
   rewritten: `getMe` and `registerSession` now share one `loadMeSnapshot()`
   query so `/v1/me` stays a single round trip while returning more.
3. **`users` gains `declared_applicant_count`.** Migration handles it; the
   Drizzle `users.ts` is updated to match.
4. **`0001` rollback is now gated.** Rolling back `0001` requires rolling back
   `0002` first — `applicants.user_id` FKs to `users`.

## Design decisions worth knowing

- **Relationship is two columns.** `relationship_code` (wife/husband/son/…) is
  CMS content in a `relationships` table; `relationship_category`
  (spouse/child/parent) is the locked PRD §2 rule-engine key, denormalised onto
  `applicants` so the Module 3 checklist query never joins on the request path.
  Clients never send the category — it is derived server-side.
- **Changing relationship resets `case_generated_at` to NULL** when the category
  changes. Module 3 must treat NULL as "regenerate", otherwise the user is left
  on a checklist for the wrong category.
- **`current_stage` is NULLABLE.** NULL means Screen 7 has not run, which is
  exactly what drives `stage_pending`. A DEFAULT would make "not chosen"
  indistinguishable from "chose the first stage".
- **8 canonical stages, not Screen 7's 8 labels.** "Nulla Osta in process" and
  "…received" are one stage plus tracker state, not two stages. Screen 7 maps
  its selector onto `(currentStage, nullaOstaStatus)`.
- **`onboarding_state` is always recomputed from facts,** never sent by the
  client, and **never regresses from `complete`.** Adding an applicant after
  onboarding therefore requires `currentStage` in the same request.
- **Legal acceptance is matched on `(doc_type, version)`, not version id.** The
  same terms in another locale are the same agreement. This assumes version
  strings stay in lockstep across locales when publishing from Screen 44.
- **Nulla Osta expiry is stored, not computed on read,** so the Module 5 Cron
  reminder sweep is a plain indexed date scan. Derived from
  `app_config.nulla_osta.validity_months` until the requirements CMS lands, at
  which point PRD §14 requires reading it from the verified requirement and this
  key becomes the fallback.
- **Dates are cast to text in SQL.** node-postgres parses a `DATE` column to a
  JS `Date` at local midnight, which shifts the day in any non-UTC runtime.
- **Write gate = PRD §7.** `free` and `premium` write; `grace_read_only` and
  `expired` do not. Access level is computed against `now()`, not trusted from
  `premium_status`, because the Cron sweep may not have run yet.
- **A paid applicant cannot be self-deleted** — it would strand an order and
  become a refund dispute. Support path only.
- **`generateCase()` is a stub** in `modules/checklist/checklist.service.ts`,
  called inside the stage-write transaction so the case lives or dies with the
  stage. Same pattern `resolveEntitlement()` used in Module 1. It stays a no-op
  until requirement definitions exist (Module 3/4) and must not set
  `case_generated_at`.
- **`applicant_stage_events` is append-only and unused by any screen.** PRD §21
  journey-completion is unmeasurable without it and it cannot be backfilled.

## Deliberate deviations from the PRD

- **No stored `is_expired_pending` boolean** (PRD §7 names one). It is fully
  derivable from `premium_status` + `grace_until`, and a second source of truth
  for a write gate is a desync waiting to happen. `resolveAccess()` computes it.
- **No IP address on `legal_acceptances`.** PRD §19 data minimisation; the
  `device_id` we already hold is sufficient evidence.

## Setup

```bash
export DATABASE_URL="$(grep DATABASE_URL .dev.vars | cut -d'"' -f2)"
pnpm db:migrate
```

## Verify

**1. Migration applies and rolls back cleanly**
```bash
pnpm db:status   # ✓ 0001_auth_devices ✓ 0002_legal_applicants
pnpm db:rollback && pnpm db:migrate           # must succeed twice in a row
```
Expect `relationships` (6 seeded rows), `legal_versions` (1 current disclaimer),
`legal_acceptances`, `applicants`, `applicant_stage_events`;
`users.declared_applicant_count` present; `app_config` has `onboarding` and
`nulla_osta` keys.

**2. Fresh account is gated at the disclaimer**
```bash
D1=$(uuidgen | tr 'A-Z' 'a-z')
curl -s localhost:8787/v1/auth/session -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"deviceId\":\"$D1\",\"platform\":\"android\",\"appVersion\":\"0.1.0\"}" | jq .legal
# { "requiresAcceptance": true, "pendingDocTypes": ["disclaimer"] }
```
`onboardingState` must be `disclaimer_pending`.

**3. Applicant creation is blocked before acceptance**
```bash
curl -i localhost:8787/v1/applicants -X POST \
  -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $D1" -H "Content-Type: application/json" \
  -d '{"displayName":"Ayesha","relationshipCode":"wife","currentLocation":"pakistan"}'
# 403 LEGAL_ACCEPTANCE_REQUIRED
```

**4. Accept, then walk the onboarding state machine**
```bash
VID=$(curl -s localhost:8787/v1/legal/current -H "Authorization: Bearer $TOKEN" \
      -H "X-Device-Id: $D1" | jq -r '.documents[0].id')

curl -s localhost:8787/v1/legal/accept -X POST -H "Authorization: Bearer $TOKEN" \
  -H "X-Device-Id: $D1" -H "Content-Type: application/json" \
  -d "{\"versionIds\":[\"$VID\"],\"appVersion\":\"0.1.0\"}"
# onboardingState: applicants_pending

curl -s localhost:8787/v1/onboarding/applicant-count -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "X-Device-Id: $D1" -H "Content-Type: application/json" -d '{"declaredApplicantCount":2}'
# onboardingState: applicants_pending  (0 of 2 created)
```
Create applicant 1 → still `applicants_pending`. Create applicant 2 →
`stage_pending`. Set a stage on one → `stage_pending`. Set the second →
`complete`.

**5. Category derivation and the DOB rule**
```bash
curl -s localhost:8787/v1/applicants -X POST -H "Authorization: Bearer $TOKEN" \
  -H "X-Device-Id: $D1" -H "Content-Type: application/json" \
  -d '{"displayName":"Ali","relationshipCode":"son","currentLocation":"pakistan"}'
# 422 VALIDATION_FAILED, details.dateOfBirth  (son requires DOB)
```
With `"relationshipCode":"wife"` the response must contain
`relationshipCategory: "spouse"` — never echoed from the request.

**6. Nulla Osta expiry derivation**
Create with `"nullaOstaIssueDate":"2026-04-01"` and no expiry → response
`nullaOsta.expiryDate` is `2026-10-01` (issue + `validity_months`, default 6)
and `daysRemaining` is a plain integer. Change `app_config.nulla_osta` to
`{"validity_months": 12}` and repeat — no redeploy, new expiry.

**7. Failure modes**
| Request | Expect |
|---|---|
| `relationshipCode: "cousin"` | 422 `VALIDATION_FAILED`, `details.relationshipCode` |
| `dateOfBirth: "2030-01-01"` | 422 `VALIDATION_FAILED` (future date) |
| `dateOfBirth: "01-01-1990"` | 422 `VALIDATION_FAILED` (format) |
| `currentLocation: "canada"` | 422 `VALIDATION_FAILED` |
| `PATCH /v1/applicants/:id` with `currentStage` | 422 — use the `/stage` route |
| `PATCH /v1/applicants/:id` with `{}` | 422 `VALIDATION_FAILED` |
| another account's applicant id | 404 `NOT_FOUND` (never 403 — no existence leak) |
| `POST /v1/legal/accept` with a stale version id | 422 `VALIDATION_FAILED` |
| create the 11th applicant | 409 `APPLICANT_LIMIT_REACHED` |
| create without `currentStage` once `complete` | 409 `ONBOARDING_STEP_INVALID` |

**8. Grace write-gate** (no orders module yet, so set it by hand)
```sql
UPDATE applicants
   SET premium_status = 'expired_pending_confirmation', grace_until = now() + interval '10 days'
 WHERE id = '<applicant-id>';
```
Then `PATCH /v1/applicants/:id` → `403 APPLICANT_READ_ONLY`, and `GET` still
returns the applicant with `access.level = "grace_read_only"`, `canWrite: false`.
Set `grace_until` to the past → level becomes `expired`, and `/v1/me`
`entitlement.graceApplicantIds` empties without the Cron sweep having run.

**9. Entitlement wiring**
```sql
UPDATE applicants SET premium_status = 'active' WHERE id = '<applicant-id>';
```
`GET /v1/me` → `entitlement.hasAnyPremium: true` and the id in
`premiumApplicantIds`. This is the stub from Module 1 now closed.

**10. CPU budget** — `/v1/me` does strictly more work than in Module 1. Check
`wrangler tail` or the dashboard p99 for `/v1/me` again; it must stay well under
10 ms. If it does not, the fix is the $5/mo Workers Paid escape hatch (PRD §22
risk 8b), not splitting the query back into round trips.

## Client contract (Flutter, Module 3 input)

- Route on `me.user.onboardingState`, and route to the Disclaimer Gate whenever
  `me.legal.requiresAcceptance` is true — including for an existing user after a
  version bump. Never on local flags.
- Resume the Screen 6 loop from `me.applicants.declaredCount` vs `total`;
  resume Screen 7 from `awaitingStage`.
- Cache `/v1/reference/relationships` locally; it changes rarely.
- Branch per-applicant UI on `applicant.access.level`
  (`free` / `premium` / `grace_read_only` / `expired`) and disable edit controls
  on `canWrite: false` rather than waiting for a 403.
- `relationshipCategory` is server-derived — send `relationshipCode` only.
