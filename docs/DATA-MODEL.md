# Data model

Descriptive — the migrations in `apps/api/migrations/` are the truth. Generated
from a live database at migration `0003` on 2026-10-14
(`information_schema` + `pg_constraint` + `pg_indexes`). Update in the same PR as
any migration.

Conventions: `uuid` PKs (`gen_random_uuid()`), `timestamptz` everywhere, `date` only
for calendar dates (cast to text in SQL — invariant 9), enums as `text` + `CHECK`
(adding a value is a cheap `DROP/ADD CONSTRAINT`, not an `ALTER TYPE`), soft delete
via `status` + `deleted_at` with a consistency `CHECK`.

> Planned tables for Modules 3–10 (with indexes, retention and open items): `docs/ERD.md`.

## Entity overview

```
users 1─* devices
users 1─* legal_acceptances *─1 legal_versions
users 1─* applicants *─1 relationships
applicants 1─* applicant_stage_events
app_config (key/value, no FKs)        schema_migrations (runner bookkeeping)
```

## Tables

### `users` — one per Firebase uid (0001, +0002)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| firebase_uid | text NN, unique | identity link; nothing else from Firebase is trusted |
| email | text | unique on `lower(email)` where not null and not deleted |
| display_name | text | user-set value is never overwritten by login |
| onboarding_state | text NN default `disclaimer_pending` | `disclaimer_pending\|applicants_pending\|stage_pending\|complete`; server-recomputed only |
| declared_applicant_count | smallint, 1–99 | Screen 5 intent, not a count |
| status | text NN `active\|deleted` | |
| last_login_at, deleted_at, created_at, updated_at | timestamptz | |

### `devices` — app-level sessions (0001)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → users ON DELETE CASCADE | |
| device_id | uuid NN | client UUIDv4; unique per `(user_id, device_id)` |
| platform | text `android\|ios` | |
| app_version, os_version, model | text | |
| fcm_token | text | push target |
| status | text `active\|evicted\|signed_out` | |
| last_login_at, last_seen_at, evicted_at, created_at | timestamptz | `last_seen_at` written by `/v1/me` only |

### `legal_versions` — versioned legal text (0002)

`doc_type` (`disclaimer|terms|privacy`), `locale` (default `en`), `version` text,
`title`, `body_md`, `is_mandatory` (default true), `is_current` (default false),
`published_at`, `published_by` (uuid, **no FK yet** — admin table arrives with RBAC).
Unique `(doc_type, locale, version)`; at most one current per `(doc_type, locale)`;
`is_current ⇒ published_at IS NOT NULL`. **Rows are content: never inserted by a
migration** (CI + `preflight` enforce it).

### `legal_acceptances` — evidence of acceptance (0002)

`user_id` FK CASCADE, `legal_version_id` FK RESTRICT (a version that was accepted
can never be deleted), `device_id`, `app_version`, `accepted_at`. Unique
`(user_id, legal_version_id)`. **No IP address** (PRD §19). Acceptance is matched on
`(doc_type, version)` across locales.

### `relationships` — CMS-driven picker (0002)

`code` text PK, `labels` jsonb (must contain `en`), `category`
(`spouse|child|parent`), `requires_dob`, `sort_order`, `is_active`. Seeded by the
migration (config-like, schema-adjacent). `requires_dob` per relation is still to be
confirmed with the content owner.

### `applicants` — one person on a visa journey (0002)

| Column | Notes |
|---|---|
| user_id FK CASCADE | every query filters on it |
| display_name, relationship_code FK → relationships RESTRICT | |
| relationship_category | `spouse\|child\|parent`, denormalised from relationship, **never client-supplied** |
| date_of_birth date, current_location `pakistan\|italy\|other` | |
| current_stage | one of 8 stages or **NULL = Screen 7 not run** (never add a default) |
| stage_updated_at, case_generated_at | `case_generated_at` NULL until Module 3 generates the case |
| nulla_osta_status `not_applicable\|not_started\|in_process\|received`, nulla_osta_issue_date, nulla_osta_expiry_date | expiry ≥ issue |
| premium_status `none\|active\|expired_pending_confirmation\|expired`, access_until, grace_until | entitlement inputs; bucketed against `now()` on read |
| visa_status `visa_granted\|visa_granted_verified`, visa_granted_self_at, visa_granted_verified_at | PRD §7 confirmation paths |
| status `active\|deleted`, deleted_at, created_at, updated_at | soft delete; blocked while `premium_status <> 'none'` |

### `applicant_stage_events` — stage history (0002)

`applicant_id` FK CASCADE, `from_stage`, `to_stage`, `source` (`user|admin|system`),
`created_at`. Append-only.

### `app_config` — every tunable (0001+)

`key` PK, `value` jsonb, `description`, `updated_by` (uuid, no FK yet), `updated_at`.
Current keys: `auth {max_active_devices: 2}`, `onboarding {max_applicants: 10}`,
`nulla_osta {validity_months: 6, expiry_warning_days: 30}`. Read with
`readConfig(db, key, FALLBACK)` — stored value is spread over the fallback.

## Indexes (non-PK)

| Table | Index | Serves |
|---|---|---|
| users | `users_firebase_uid_uq` | login upsert |
| users | `users_email_lower_uq` (partial) | uniqueness |
| devices | `devices_user_device_uq (user_id, device_id)` | session lookup, upsert |
| devices | `devices_user_active_idx (user_id, last_login_at DESC) WHERE active` | eviction, device list |
| devices | `devices_fcm_token_idx (user_id) WHERE active AND fcm_token NOT NULL` | push fan-out |
| legal_versions | `legal_versions_current_uq (doc_type, locale) WHERE is_current` | current lookup |
| legal_versions | `legal_versions_doc_locale_version_uq` | uniqueness |
| legal_acceptances | `legal_acceptances_user_version_uq (user_id, legal_version_id)` | pending-legal check |
| legal_acceptances | `legal_acceptances_user_idx (user_id)` | **redundant** — covered by the unique index above. Drop in a later migration (costs a write per acceptance, nothing else). |
| legal_acceptances | `legal_acceptances_legal_version_idx` | FK cover (0003) |
| applicants | `applicants_user_active_idx (user_id, created_at) WHERE active` | list, counts |
| applicants | `applicants_user_premium_idx (user_id) WHERE active AND premium <> none` | entitlement |
| applicants | `applicants_access_until_idx`, `applicants_nulla_osta_expiry_idx` (partial) | Cron sweeps |
| applicants | `applicants_relationship_code_idx` | FK cover (0003) |
| applicant_stage_events | `(applicant_id, created_at DESC)` | history |
| relationships | `relationships_active_idx (sort_order) WHERE is_active` | picker |

CI asserts every FK has a covering index (leading column).

## Growth & retention at 30k users

| Table | Rows at 30k users | Retention |
|---|---|---|
| users | 30k | life of account; GDPR delete clears PII, keeps row |
| devices | ≤ ~90k (evicted/signed-out rows accumulate) | **to decide:** purge non-active rows older than 90 days (Cron) |
| applicants | ~60–90k | life of account |
| applicant_stage_events | ~8–20 per applicant → ≤ ~2M | life of applicant; bounded by stage count |
| legal_acceptances | ~1–3 per user per version bump | **keep** — evidential (PRD §18); deleted only with the account |
| legal_versions, relationships, app_config | tens | content |

The CLAUDE.md rule "append-only tables declare retention in the creating migration"
was not followed for `applicant_stage_events` and `legal_acceptances` (0002). The
rules above are the declaration; applied migrations are immutable, so they are
recorded here and in the next migration's header comment.

## Known model risks

1. **Email uniqueness vs Firebase.** If a user deletes their Firebase account and
   signs up again with the same email, Firebase issues a new uid; the upsert inserts
   a second `users` row with the same email and hits `users_email_lower_uq` → 500 on
   login. Decide before launch: drop the unique index (identity is `firebase_uid`), or
   look up by email and re-link. Recommendation: drop it — email is not the identity.
2. **Deleted-user login re-populates PII** — see `API-CONTRACT.md` §Session.
3. `published_by` / `updated_by` have no FK until the admin table exists — add
   `NOT VALID` FKs then validate, per expand–contract.
