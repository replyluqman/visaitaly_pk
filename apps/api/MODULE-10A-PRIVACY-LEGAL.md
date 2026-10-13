# Module 10a — Privacy rights, legal manager, case lookup

## 1. Purpose
The parts of Module 10 that gate launch and don't depend on money: GDPR access + erasure + consents (`docs/DATA-PRIVACY.md`; Google Play requires in-app deletion),
the Legal / Disclaimer version manager (Screen 44), and the audited User / Case Lookup (Screen 36). Builds on 4a (admin identity, audit) and 5 (notifications).
Still to do in Module 10: the Play-required public deletion web page (CMS), pricing/config editor (Module 6), refund/support/renewal/payout lookups (need those modules).

## 2. Contract
**User (session):** `GET|PUT /v1/account/consents` · `POST /v1/account/data-export` (202) · `GET /v1/account/data-exports/:id` · `GET …/:id/content?exp&sig` (capability) ·
`DELETE /v1/account` `{confirm:true}` (202; needs a sign-in ≤ 5 min old).
**Admin:** `GET|POST /v1/admin/legal-versions`, `PATCH …/:id` (drafts), `POST …/:id/publish`, `GET …/:id/acceptances` (scope `legal_manage`; `read_only` reads) ·
`GET /v1/admin/lookup?email=|userId=` (any active admin; always audited).
New code `REAUTH_REQUIRED` 401 (not session-terminal). Breaking changes: none.

## 3. Data — `0011_privacy_legal`, `0012_full_fk_indexes` (both expand-only)
`data_requests` (no FK on `user_id` by design; kept 6 years; unique open export / unique erasure per user), `consents`, `users_email_lower_idx` (lookup), `legal_versions`
FK to `admins` + **immutability trigger** (a published version can only change `is_current`), `legal_acceptances (legal_version_id, accepted_at, id)`.
`0012`: five **unconditional** indexes (see "Found by Gate 4").

## 4. Decisions
1. **Erasure is two-phase.** `DELETE /v1/account` (needs `{confirm:true}` + `auth_time` ≤ `privacy.reauth_window_seconds`) marks the user deleted, signs every device out and queues the request in ONE
   transaction → every later call is `USER_DELETED`, login is refused. The Cron then erases: R2 objects **first** (bounded per run — object calls are subrequests), then their rows; applicants (cascading
   checklist progress, next actions, applicant notifications), notifications, preferences, consents, devices; then the **tombstone** (email / name / `firebase_uid` nulled, row kept to anchor legal
   acceptances); then the Firebase login. Resumable and idempotent: a failure records `last_error`, the next tick continues, and PII is not touched while objects remain. `failed` after `max_attempts`.
2. **Retained on purpose:** the tombstone, `legal_acceptances` (proof of consent), `data_requests`. Later modules' financial records are pseudonymised, not deleted (DATA-PRIVACY §4).
3. **Firebase Authentication deletion** uses the project's service account via Identity Toolkit `accounts:delete` (same secret as push; needs the "Firebase Authentication Admin" role). With no
   service account the data is still erased and the gap is **recorded** (`identity_deleted_at IS NULL`, uid kept in `data_requests` for manual follow-up) — never silently skipped.
4. **Export is JSON, not ZIP** (deviation from DATA-PRIVACY §3, which assumed a ZIP of files): a Worker can't stream a ZIP of up to 500 MB inside its memory limit. The JSON holds every user-owned row (never tokens,
   hashes or other people's data) and lists documents with their API paths; the signed-in user downloads the files. One open export per user; `export_cooldown_hours` (24) between requests; stored privately,
   announced in the Activity tab (`data_export_ready`), deleted after `export_retention_days` (7) while the request row stays as the compliance record. Download = short-lived GET-scoped capability URL, attachment, no-store.
5. **Consents are OFF until the user answers** (`answered:false` tells the client to ask); a new `policyVersion` is stored with each answer so a new policy can re-ask.
6. **Legal versions**: drafts are editable; publish is one transaction that demotes the old current version and promotes the new (never zero or two current); published text is immutable (API 409 *and* DB trigger).
   Acceptance matches on `(doc_type, version)`, so publishing 1.1 makes `/v1/me` ask every user again.
7. **Case lookup** is a privacy surface: exactly one key, read-only, returns no tokens / documents / message bodies, and **every call is audited — found or not — with the key *type* and the user id, never the email typed**.

## 8. Test results
**267 tests green** (`privacy.test.ts` 18, `legal-admin.test.ts` 10). Round-trip: 12 migrations, identical schema.

| Gate | Result |
|---|---|
| 1 Static | typecheck clean; wrangler bundles 3 envs (1027 KiB / 198 KiB gz) |
| 2/3 | consents (default off, partial, validation, per user); export (202/409/429, content = own data only — no FCM token, no other user, no R2 key; notification; status + URL; wrong/expired signature, other user 404; expiry deletes the object but keeps the request; failure recorded then `failed`); deletion request (confirm, `REAUTH_REQUIRED` at 1 h, 202, immediate `USER_DELETED`, devices signed out, login refused, second request refused); **erasure** (objects before rows, bystander untouched, tombstone, legal proof retained, uid cleared once identity deleted, object budget resumes across ticks, R2 failure keeps PII until objects are gone, identity `retry`/`not_found`/unconfigured, idempotent, same Firebase account re-registers as a fresh empty account); identity deleter vs fake fetch; legal manager (scopes, validation, duplicate, draft-only edit, **immutability via API and SQL**, atomic publish, forced re-acceptance, acceptances paged + audited); lookup (email/id, exactly-one, 404 still audited, no email in audit, tombstone view) |
| 4 | at 30k users / 75k applicants / 208k documents: lookup by email 0.02 ms, lookup readiness 0.12, queues 0.01, acceptances keyset 0.10, **erasure `DELETE applicants` with cascades 0.03 ms** (after 0012). 66 queries pass |
| 5 | erasure needs fresh auth + explicit confirm; audit never holds PII values; export contains no secrets; capability URLs short-lived and verb-scoped; legal text immutable; **open:** the end-to-end erasure on staging with real R2 + Firebase (DATA-PRIVACY "Test"), the public deletion URL for Play, lawyer review of consent copy |

### Found by Gate 4 (systemic)
Five foreign keys were "covered" only by **partial** indexes (`WHERE status = 'active'`). Postgres can't use those for the unconditional lookups a parent delete, cascade, `SET NULL`, or an erasure
(`WHERE user_id = $1`, all statuses) performs — erasure seq-scanned `documents` (208k rows, 21 ms *per applicant*, worse with the `SET NULL` cascade) and `applicants`. Fixed in 0012; the CI and `preflight`
foreign-key audit now require an **unconditional** index.
