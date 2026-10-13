# API contract — v1

> Prose contract for the **built** surface. The machine-readable superset, including planned routes
> (`x-status: planned`), is `docs/api/openapi.yaml` (`pnpm lint:openapi`). Update both in the same PR.

Descriptive: the source of truth is `packages/shared/src/*` (types + zod) and the
route files. This doc must change in the same PR as either. Cross-checked against
`apps/api/src/modules/*/*.routes.ts` on 2026-10-14.

## Conventions

| Topic | Rule |
|---|---|
| Base path | `/v1`. A breaking change ships as `/v2` alongside `/v1`, never in place. |
| Auth | `Authorization: Bearer <Firebase ID token>` on every `/v1` route. |
| Device | `X-Device-Id: <UUIDv4>` on every route guarded by `requireSession` (all except `POST /v1/auth/session`, which takes `deviceId` in the body). |
| Body | JSON, camelCase. Unknown fields are stripped by zod, not rejected. |
| Dates | `YYYY-MM-DD` strings for calendar dates (never `Date` objects); ISO-8601 UTC for timestamps. |
| Locale | `?locale=xx` (2 lowercase letters) selects labels; anything else falls back to `en`. Urdu is gated by PRD §11a. |
| IDs | UUIDs. Malformed id in a path → 422 `VALIDATION_FAILED`, not 404. |
| Ownership | Another user's id → **404 `NOT_FOUND`**, never 403. |
| Pagination | Cursor on `(created_at, id)` for every list that can grow. Exempt: lists bounded by `app_config` (devices ≤ `max_active_devices`, applicants ≤ `max_applicants`). |
| Additive changes | New optional response fields are non-breaking. Clients must ignore unknown fields. |

### Error body (every non-2xx)

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed.",
             "details": { "dateOfBirth": ["Date of birth is required for Son."] },
             "requestId": "9c1e…" } }
```

Clients branch on `code` only. `message` is display text and may change. `details`
only on `VALIDATION_FAILED`. Quote `requestId` in support tickets.

| Code | HTTP | Terminal? | Client action |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | yes* | Refresh the Firebase token once and retry; if it fails again, sign out. |
| `DEVICE_HEADER_MISSING` | 400 | no | Client bug. Log it. |
| `DEVICE_UNKNOWN` | 401 | yes | Sign out → Login. |
| `DEVICE_EVICTED` | 401 | yes | Sign out → Login, "signed out: device limit reached". |
| `DEVICE_SIGNED_OUT` | 401 | yes | Sign out → Login, "signed out from another device". |
| `USER_DELETED` | 403 | yes | Sign out → Login, account-deleted notice. |
| `LEGAL_ACCEPTANCE_REQUIRED` | 403 | no | Route to Disclaimer Gate (Screen 4). |
| `ONBOARDING_STEP_INVALID` | 409 | no | Step taken out of order; re-route from `GET /v1/me`. |
| `APPLICANT_LIMIT_REACHED` | 409 | no | Show message (limit is in it). |
| `APPLICANT_READ_ONLY` | 403 | no | Grace/expired banner; disable write UI. |
| `VALIDATION_FAILED` | 422 | no | Show `details` per field. |
| `NOT_FOUND` | 404 | no | Item gone or not yours. |
| `CONFLICT` | 409 | no | Show message. |
| `RATE_LIMITED` | 429 | no | Back off. (Reserved — no limiter yet.) |
| `INTERNAL` | 500 | no | Generic error + `requestId`. Retry idempotent calls only. |

\* "Terminal" = in `SESSION_TERMINAL_CODES`. `UNAUTHENTICATED` is in the set, but
the server also returns it when it cannot fetch Google's keys. Treating it as
terminal without one token refresh would sign out every user during a Google/KV
blip. See `FLUTTER-ARCHITECTURE.md` §Networking.

## Endpoints

Auth column: **T** = token only (`requireAuth`), **S** = token + registered active
device (`requireSession`), **—** = public.

### Health

| Method | Path | Auth | 200 |
|---|---|---|---|
| GET | `/health` | — | `{ "ok": true }` |

### Session & account (Module 1, extended in Module 2)

| Method | Path | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| POST | `/v1/auth/session` | T | `registerSessionSchema`: `deviceId` (uuid), `platform` (`android\|ios`), `appVersion`, `osVersion?`, `model?`, `fcmToken?` | **201** new user / **200** existing → `RegisterSessionResponse` | 401, 422 |
| GET | `/v1/me` | S | — | `MeResponse` | terminal codes |
| GET | `/v1/devices` | S | — | `{ devices: DeviceSummary[] }` (active only) | terminal codes |
| DELETE | `/v1/devices/:deviceId` | S | — | **204** | 404 (no active session for that id), 422 |

`POST /v1/auth/session` is idempotent — retry it freely. Call it after **every**
Firebase sign-in, not just the first.

Gap (must fix in the account-deletion module, `DATA-PRIVACY.md`):
`registerSession` does not check `users.status`. A deleted account still gets 200
here and is stopped one call later by `requireSession` (`USER_DELETED`) — but the
upsert has already written `email`/`display_name` back onto the deleted row,
undoing the PII wipe. No deletion flow exists yet, so nothing is affected today.

`MeResponse` — the app-launch snapshot, one DB round trip:

```ts
{
  user:        { id, email, displayName, onboardingState, createdAt },
  entitlement: { premiumApplicantIds: string[], graceApplicantIds: string[], hasAnyPremium: boolean },
  devices:     { maxActive: number, activeCount: number },
  legal:       { requiresAcceptance: boolean, pendingDocTypes: ('disclaimer'|'terms'|'privacy')[] },
  applicants:  { declaredCount: number | null, total: number, awaitingStage: number },
}
// RegisterSessionResponse = MeResponse & { session: { evictedDeviceIds: string[], isNewUser: boolean } }
```

`onboardingState`: `disclaimer_pending → applicants_pending → stage_pending → complete`.
Server-computed; never regresses from `complete`. Route on it, never on local flags.

### Legal gate (Module 2)

| Method | Path | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| GET | `/v1/legal/current?locale=` | S | — | `CurrentLegalResponse` `{ documents: LegalVersionSummary[], requiresAcceptance }` (no bodies) | — |
| GET | `/v1/legal/current/:docType?locale=` | S | `docType`: `disclaimer\|terms\|privacy` | `LegalDocumentResponse` (summary + `bodyMd`) | 404, 422 |
| POST | `/v1/legal/accept` | S | `acceptLegalSchema`: `versionIds` (1–10 uuids), `appVersion?` | `{ acceptedVersionIds, onboardingState }` | 422 (a version is no longer current, or a mandatory doc is missing) |

Send the version ids you displayed. If a new version was published meanwhile the
server answers 422 — reload and show it. Re-accepting is a harmless no-op.

### Onboarding & reference (Module 2)

| Method | Path | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| PATCH | `/v1/onboarding/applicant-count` | S | `{ declaredApplicantCount: 1–99 }` | `{ declaredApplicantCount, onboardingState }` | 403 `LEGAL_ACCEPTANCE_REQUIRED`, 422 |
| GET | `/v1/reference/relationships?locale=` | S | — | `{ relationships: RelationshipOption[] }` `{ code, label, category, requiresDob }` | — |

Cache relationships client-side; they change rarely.

### Applicants (Module 2)

| Method | Path | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| GET | `/v1/applicants?locale=` | S | — | `ApplicantListResponse` `{ applicants: Applicant[], maxApplicants }` | — |
| POST | `/v1/applicants?locale=` | S | `createApplicantSchema` | **201** `{ applicant, onboardingState }` | 403 `LEGAL_ACCEPTANCE_REQUIRED`, 409 `APPLICANT_LIMIT_REACHED`, 409 `ONBOARDING_STEP_INVALID`, 422 |
| GET | `/v1/applicants/:id?locale=` | S | — | `Applicant` | 404, 422 |
| PATCH | `/v1/applicants/:id?locale=` | S | `patchApplicantSchema` (any subset, ≥1 field) | `Applicant` | 403 `APPLICANT_READ_ONLY`, 404, 422 |
| PATCH | `/v1/applicants/:id/stage?locale=` | S | `{ currentStage }` (8 stages) | `{ applicant, onboardingState }` | 403 `APPLICANT_READ_ONLY`, 404, 422 |
| DELETE | `/v1/applicants/:id` | S | — | `{ onboardingState }` (soft delete) | 404, 409 `CONFLICT` (applicant has a purchase) |

`createApplicantSchema`: `displayName` (1–80), `relationshipCode`, `dateOfBirth?`
(past `YYYY-MM-DD`; required when the relationship's `requiresDob`),
`currentLocation` (`pakistan|italy|other`), `nullaOstaStatus?`,
`nullaOstaIssueDate?`, `nullaOstaExpiryDate?` (omit → derived from issue date +
`app_config.nulla_osta.validity_months`), `currentStage?` (required once
onboarding is `complete`).

`relationshipCategory` is never accepted from the client — derived from
`relationshipCode`.

`Applicant`:

```ts
{ id, displayName, relationshipCode, relationshipLabel, relationshipCategory,
  dateOfBirth: string|null, currentLocation, currentStage: JourneyStage|null,
  stageUpdatedAt, caseGeneratedAt /* null until Module 3 */,
  nullaOsta: { status, issueDate, expiryDate, daysRemaining /* negative once expired */ },
  access: { level: 'free'|'premium'|'grace_read_only'|'expired', canWrite, accessUntil, graceUntil },
  createdAt }
```

`currentStage: null` means Screen 7 has not run for that applicant.

## Planned (not built — do not call)

Module 3 checklist: `GET /v1/applicants/:id/checklist`, `GET /v1/checklist/:id`,
`PATCH /v1/checklist/:id`. Contract is fixed in that module's doc before code.

## Known gaps

- No `X-Request-Id` response header — the id is only in error bodies. Add it before
  launch so successful-but-wrong responses can be traced too.
- No rate limiter yet (`RATE_LIMITED` reserved). Cloudflare rate-limiting rules on
  `/v1/auth/session` are the first line; see `SECURITY.md`.
- CORS allows `*.visaitaly.pk` — **assumed domain**, confirm before launch. The mobile
  app does not send `Origin`, so CORS only matters for the CMS.
