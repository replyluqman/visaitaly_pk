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
| email | text | **not unique** (0004) — identity is `firebase_uid` |
| display_name | text | user-set value is never overwritten by login |
| onboarding_state | text NN default `disclaimer_pending` | `disclaimer_pending\|applicants_pending\|stage_pending\|complete`; server-recomputed only |
| declared_applicant_count | smallint, 1–99 | Screen 5 intent, not a count |
| auth_provider | text NN default `firebase` | `firebase\|native` (CHECK) — which issuer vouches for the account; `native` is for the ADR 0013 cutover (0014) |
| email_verified | boolean NN default false | rewritten from the token at every login (0014) |
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

### Checklist engine (0005) — see `apps/api/MODULE-03-CHECKLIST.md`

- `sources` — authoritative URL (https only, unique), name jsonb, authority `embassy|government|service_provider`, hash fields.
- `source_flags` — hash-change queue; at most one `open` per source; resolved rows purged after 24 months (Module 4 Cron).
- `requirements` — the catalogue: locale-keyed jsonb copy, declarative applicability (`applies_spouse/child/parent`,
  `applies_locations`, `min/max_age_years`, `requires_nulla_osta_status`), flags (`blocks_submission`,
  `translation_required`, `apostille_required`), `stage_order` (generated), `version` (trigger-bumped on any content edit),
  `verification_status` with a CHECK that published/reviewed rows carry a source + verification time.
  `last_verified_by` has no FK until the admin table exists.
- `applicant_requirements` — one row per (applicant, published requirement) incl. non-applicable; stored `status` has 4 values,
  `not_applicable` is derived from `is_applicable`; `needs_review`; `user_id` denormalised for the ownership WHERE.
  ≈ 1.9M rows at 30k users / 75k applicants / 25 requirements.
- `app_config['checklist'] = {free_preview_items: 3}`.

### `eligibility_check_versions` (0006)
Versioned Quick Check copy: `questions` (≤ 6, with server-side `mapsTo`), `summaries` per category, `disclaimer`, optional `wa.me`
link, `is_current` (at most one). Content is CMS/seed only.

### Privacy & legal (0011) · full FK indexes (0012) — see `apps/api/MODULE-10A-PRIVACY-LEGAL.md`
`data_requests` (export/erasure; no FK on `user_id`; 6-year retention; one open export and one erasure per user), `consents` PK `(user_id, purpose)`; `legal_versions` gains an FK to `admins`
and an immutability trigger; `users_email_lower_idx` (case lookup). **A foreign key needs an unconditional index** — partial indexes do not count (CI/preflight audit).

### Support (0013) — see `apps/api/MODULE-08-SUPPORT.md`
`support_threads` (one per user; status open|awaiting_support|awaiting_user|closed; `sla_due_at` exists **iff** awaiting_support — CHECK), `support_messages` (sender user|admin|system, body ≤ 4000, topic, `user_id` denormalised so ownership is one-table;
a user message never carries an admin id — CHECK), `support_attachments` (jpeg/png; pending|attached|deleted), `canned_responses` (code, English body with placeholders). Config: `support`, `sla` (`working_hours_text` is CMS copy, no default).
Indexes: SLA inbox `(sla_due_at, id) WHERE awaiting_support`, `(status, last_message_at DESC, id)`, thread view `(thread_id, created_at, id)`, unread partial, FK covers (all unconditional). `messages.order_id` has no FK until Module 6.
Retention: **closed threads deleted `support.retention_months` (24) after the last message** with their R2 attachments; abandoned uploads after 2× the upload TTL. Included in account erasure and the data export.

### Notifications (0010) — see `apps/api/MODULE-05-NOTIFICATIONS.md`
`notification_templates` PK `(type, locale)` (CMS/seed content), `notifications` (tab, type, rendered title/body, mandatory `deep_link`, `payload`, unique `(user_id, dedupe_key)`,
`push_sent_at`/`push_attempts`, `read_at`; ≈ 1M rows/year), `notification_preferences` PK `(user_id, tab, channel)` (in-app cannot be disabled), `notification_dispatch`
(requirement versions already announced). Config: `notifications`, `reminders`, plus `verification.recheck_after_hours`, `today.min_age_minutes`.

### CMS workflow (0009) — see `apps/api/MODULE-04B-CMS.md`
`requirement_versions` (append-only snapshot per published version, `change_summary` locale map), `sources.last_error/consecutive_failures`, FKs
`requirements.last_verified_by` / `source_flags.resolved_by` → `admins`, `app_config['verification']`. `requirements.version` now counts **published revisions only**.

### Admin foundation (0008) — see `apps/api/MODULE-04A-ADMIN.md`
`admins` (nullable unique `firebase_uid`, unique lower-case `email`, `is_super`, `status`, `created_by`), `admin_permissions` PK `(admin_id, scope)`
with the 12 PRD §16 scopes + `granted_by`, `audit_log` (append-only, trigger-enforced; 12-month retention, then archive to R2 — Module 10 Cron).

### Documents & Today (0007) — see `apps/api/MODULE-03B-DOCUMENTS-TODAY.md`
- `documents` — metadata only; bytes live in the private R2 bucket under `r2_key = u/<user>/<doc>`. `status pending|active|deleted`;
  `client_sha256` is client-asserted; **no filename**. ≈ 200k rows at 30k users.
- `next_actions` — one row per applicant (`actions` jsonb, ≤ `max_actions`), overwritten by the Cron Worker.
- `app_config['uploads']` `{max_file_bytes, max_bytes_per_user, upload_url_ttl_seconds, view_url_ttl_seconds, deleted_retention_days, allowed_mimes}`,
  `['today']` `{max_actions, expiry_window_days, batch_size}`.

## Indexes (non-PK)

| Table | Index | Serves |
|---|---|---|
| users | `users_firebase_uid_uq` | login upsert |
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
| data_requests | `…_queue_idx (status, requested_at) WHERE open`, `…_user_idx (user_id, requested_at DESC)`, `…_one_open_export_uq`, `…_one_delete_uq`, `…_export_expiry_idx` | Cron queues, cool-down probe, uniqueness, export expiry |
| users | `users_email_lower_idx (lower(email))` | case lookup |
| applicants / documents / source_flags | `applicants_user_idx`, `documents_user_idx`, `documents_applicant_all_idx`, `documents_requirement_all_idx`, `source_flags_source_idx` | unconditional FK cover: erasure + cascades |
| legal_acceptances | `legal_acceptances_version_time_idx (legal_version_id, accepted_at, id)` | acceptances keyset |
| notifications | `notifications_user_dedupe_uq (user_id, dedupe_key)`, `notifications_inbox_idx (user_id, tab, created_at DESC, id DESC)`, `notifications_unread_idx (user_id, tab) WHERE unread`, `notifications_push_queue_idx (created_at, id) WHERE push_sent_at IS NULL`, `notifications_retention_idx (read_at) WHERE read_at NOT NULL`, `notifications_applicant_idx` | idempotent generation + FK cover, inbox, bell badge, push queue, retention, FK cover |
| requirement_versions | `…_req_version_uq (requirement_id, version)`, `…_published_idx (published_at DESC, id DESC)`, `…_published_by_idx` | history, recent-updates feed, FK cover |
| requirements | `requirements_status_idx (verification_status, stage_order, sort_order, id)`, `requirements_last_verified_by_idx` | admin list by state, FK cover |
| source_flags | `source_flags_resolved_by_idx` | FK cover |
| admins | `admins_firebase_uid_uq` (partial), `admins_email_uq`, `admins_created_by_idx`, `admins_list_idx (created_at, id)` | login, first-login link, FK cover, list |
| admin_permissions | PK `(admin_id, scope)`, `admin_permissions_granted_by_idx` | scope load, FK cover |
| audit_log | `(target_type, target_id, created_at DESC)`, `(actor_id, created_at DESC)`, `(created_at DESC, id DESC)`, `(action, created_at DESC, id DESC)` | per-target / per-actor history, viewer, filter by action |
| documents | `documents_user_active_idx (user_id, created_at, id) WHERE active` | My Documents cursor list |
| documents | `documents_applicant_idx (applicant_id, created_at, id) WHERE active` | per-applicant list, FK cover |
| documents | `documents_item_idx (applicant_requirement_id) WHERE active` | item count/detail, FK cover |
| documents | `documents_user_quota_idx (user_id) WHERE active or pending` | quota sum |
| documents | `documents_expiry_idx (expiry_date) WHERE active AND not null` | Today "expiring", Module 5 reminders |
| documents | `documents_purge_idx (created_at) WHERE status <> 'active'`, `documents_r2_key_uq` | retention sweep, uniqueness |
| next_actions | `next_actions_user_idx (user_id)`, `next_actions_computed_idx (computed_at)` | Today read, stalest-first refresh |
| eligibility_check_versions | `…_version_uq`, `…_current_uq (is_current) WHERE is_current` | uniqueness, current lookup |
| sources | `sources_url_uq`, `sources_sweep_idx (last_checked_at) WHERE is_active` | uniqueness, daily hash sweep |
| source_flags | `source_flags_open_uq (source_id) WHERE open` | badge lookup + FK cover + one-open-per-source |
| source_flags | `source_flags_resolved_idx (resolved_at) WHERE status <> 'open'` | retention sweep |
| requirements | `requirements_code_uq`, `requirements_published_idx (stage_order, sort_order) WHERE published`, `requirements_source_idx` | lookup, generation order, FK cover |
| applicant_requirements | `…_applicant_req_uq (applicant_id, requirement_id)` | idempotent generation, list by applicant, FK cover |
| applicant_requirements | `…_user_applicant_idx (user_id, applicant_id)` | ownership WHERE, FK cover |
| applicant_requirements | `…_requirement_idx (requirement_id)` | FK cover, publish fan-out |

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
| applicant_requirements | ≈ 1.9M | life of applicant (CASCADE) |
| requirements, sources | tens–low hundreds | CMS catalogue; archived, never deleted |
| source_flags | a few per source per year | resolved rows purged after 24 months |
| data_requests | tens per 1,000 users | 6 years (proof of compliance) |
| support_messages | ≈ 10 per support user per year | closed threads deleted 24 months after last message (Cron) |
| notifications | ≈ 1M / year | read rows deleted after 90 days (batched Cron); unread kept |
| requirement_versions | tens–hundreds | forever (legal-defence record) |
| audit_log | ≈ 0.5M / year at a busy-admin volume | 12 months hot (trigger-enforced), then R2 archive |
| admins | tens | for life (disabled, never deleted) |
| documents | ≈ 200k | `pending` purged after 2× URL TTL; `deleted` after 30 days; `active` with the applicant |
| next_actions | ≈ 75k (one per applicant) | overwritten in place |

The CLAUDE.md rule "append-only tables declare retention in the creating migration"
was not followed for `applicant_stage_events` and `legal_acceptances` (0002). The
rules above are the declaration; applied migrations are immutable, so they are
recorded here and in the next migration's header comment.

## Known model risks

1. ~~Email uniqueness vs Firebase~~ — **resolved in 0004**: `users_email_lower_uq` dropped;
   identity is `firebase_uid`. Email is not unique and must never be used as a lookup key
   for authorisation.
2. **Deleted-user login re-populates PII** — see `API-CONTRACT.md` §Session.
3. `published_by` / `updated_by` have no FK until the admin table exists — add
   `NOT VALID` FKs then validate, per expand–contract.
