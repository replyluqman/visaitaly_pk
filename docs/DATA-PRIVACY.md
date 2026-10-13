# Data privacy — consent, export, deletion

**Applies because:** users are frequently EU-resident (PRD §17, §18 risk 3), so GDPR
applies regardless of company location. Pakistan's data-protection bill should be
re-checked for status at launch. **Not legal advice; everything here goes to the lawyer review (PRD §24).** PRD §18–§19 are the requirements; this maps them onto the system.

## 1. Data inventory

| Data | Where | Why | Retention |
|---|---|---|---|
| Email, display name, Firebase uid | `users` + Firebase Auth | account | life of account |
| Device id, model, OS, FCM token | `devices` | 2-device rule, push | life of account; evicted rows 90 d |
| Applicant name, relationship, DOB, location, Nulla Osta dates | `applicants` | personalised case | life of account |
| Checklist progress | `applicant_requirements` | product | life of account |
| Uploaded documents (passports, certificates) | R2 + `documents` | product | life of account; user can delete any time |
| Payment proofs | R2 + `payment_proofs` | verify payment | life of order record (financial) |
| Orders, receipts, ledger | Neon + R2 | financial / tax | **7 years** — ⚠ accountant to confirm |
| Delivery address | `shipments` | courier | purged 90 d after delivery |
| Support messages + attachments | `support_*` + R2 | support | 24 months after last message — ⚠ confirm |
| Payout bank details | `payout_accounts` (encrypted) | referral payouts | life of account |
| Legal acceptances | `legal_acceptances` | proof of consent | life of account + 6 y (legal defence) |
| Analytics / crash data | Firebase | product quality | per Firebase settings; consent-gated |
| Audit log | `audit_log` | legal defence | 12 m hot + archive — ⚠ confirm |

No IP addresses are stored by us (PRD §19). Cloudflare edge logs are governed by
Cloudflare's DPA.

**Processors** (need a DPA / terms acceptance each): Cloudflare, Neon, Google
Firebase, the courier partner, the bank. List them in the privacy policy.

## 2. Consent

| Purpose | Basis | Default |
|---|---|---|
| Core service (account, case, documents, orders) | contract | — (not consent-based) |
| Legal acceptances | legal obligation / contract | — |
| Analytics | consent | **off** until accepted |
| Crash reports | consent (could argue legitimate interest — lawyer to decide) | **off** until accepted |
| Marketing push | consent | off |

- Asked once, after the Disclaimer Gate, as a single screen with three toggles and
  "Accept all / Only necessary". Changeable in Account → Privacy at any time.
- Stored in `consents` with the `policy_version` shown. A new privacy-policy version
  re-asks.
- The Flutter app reads consents **before** initialising Analytics/Crashlytics.

## 3. Right of access / export (`POST /v1/account/data-export`)

1. Creates `data_requests(kind='export')`.
2. Cron builds a ZIP: `account.json` (all rows above, user-owned), plus every
   document and payment proof from R2, plus receipts.
3. Uploads to R2 under a random key; notification (Activity tab) with a signed URL
   valid 7 days. Then the export object is deleted (lifecycle rule).
4. SLA: within 30 days by law; target 24 h.

## 4. Right to erasure (`DELETE /v1/account`)

Requires **recent re-auth** (Firebase `auth_time` < 5 min) — deletion is the most
destructive action in the product.

**Synchronous (request path, one transaction):**
1. `users.status='deleted'`, `deleted_at=now()`; all devices → `signed_out`.
2. `data_requests(kind='delete', status='received')`.
3. Response 202. Every later request with that token → `USER_DELETED` (terminal).

**Asynchronous (Cron, within 24 h):**
| Data | Action |
|---|---|
| R2 documents, support attachments, exports | **delete objects**, then rows |
| `applicants`, `applicant_requirements`, `documents`, `next_actions`, `notifications`, `notification_preferences`, `devices`, `consents`, `support_threads/messages`, `referral_codes`, `payout_accounts` | hard delete |
| `orders`, `order_items`, `receipts`, `credit_ledger`, `withdrawal_requests`, `refund_requests` | **retained** (financial, legal obligation) but **pseudonymised**: user_id kept for integrity, `shipments` address purged, payment-proof images deleted once the order is beyond the refund + dispute window |
| `legal_acceptances` | retained (proof), linked only to user_id |
| `users` row | email, display_name, firebase_uid nulled/hashed; row kept as a tombstone for FK integrity |
| Firebase Auth user | deleted via Identity Toolkit from the Cron Worker (not the request path) |
| Analytics | `deleteUserData` not available client-side after deletion — call GA4 User Deletion API from Cron, or document that analytics is pseudonymous and auto-expires (lawyer to decide) |

Then `data_requests.status='completed'`, and an email confirmation from Firebase
Auth's address before the account email is erased.

**Every new PII column must be added to this table in the same PR** (SECURITY.md
data lifecycle checklist).

**Test:** executed end-to-end once on staging with a seeded account incl. R2 objects,
before first production deploy (SECURITY.md "before first production deploy").

## 5. Breach

72-hour notification duty (GDPR art. 33). Runbook: contain → assess scope from
audit_log + Workers Logs → lawyer → notify authority + affected users.
Owner and contact list in `docs/runbooks/breach.md` (create before launch).

## 6. Standing rules (engineering)

1. Collect only what the selected service needs (PRD §19). A new field needs a reason in its migration.
2. Every user-owned row is reachable from `users.id` — that is what makes deletion and export complete. No orphan PII.
3. R2 objects are private; access by short-lived signed URL only, and every key is referenced from a Neon row.
4. Admin read access to user data (Case Lookup) is audit-logged (PRD §16).
5. Staging and development never contain production data.
6. Applicants are often family members, not the account holder. The privacy policy must say the account
   holder provides their data and has the right to.
7. Never collected: card data (manual payment model), IP on legal acceptance, hardware device ids, contacts, GPS.

## 6a. Implementation status (Module 10a)

Built: consents, export, erasure (two-phase), tombstone, Firebase login deletion, audit of case lookups, legal version manager. Deviations: the **export is JSON, not a ZIP** (a Worker cannot
stream up to 500 MB of files inside its memory limit; documents are listed with API paths and downloaded by the signed-in user). **Not yet verified:** the end-to-end erasure with real R2 + Firebase
on staging; the Play-required public deletion URL; analytics deletion (GA4 User Deletion API) — pseudonymous and auto-expiring until the lawyer decides. Payment/order records (Module 6) must join the
"retained, pseudonymised" row of the table in §4 in that module's PR.

## 7. Must be fixed before the deletion flow ships (found in review) — ALL DONE

- **Login must refuse a deleted account before the upsert.** Today `registerSession` writes `email` /
  `display_name` back onto a `status='deleted'` row, undoing the PII wipe (`API-CONTRACT.md` §Session).
- **Email uniqueness.** Resolved: migration 0004 dropped `users_email_lower_uq`; re-signup after a Firebase
  deletion creates a new row (new uid).
- **Google Play** requires an in-app deletion entry point *and* a public web URL for the request.
