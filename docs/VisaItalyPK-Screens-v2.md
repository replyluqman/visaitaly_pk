# VisaItaly PK — Screens & Flows

**Version:** 2.0 (LOCKED)
**Date:** 03 Sep 2026
**Status:** Phase 2.5 complete — locked for Phase 3 (Implementation)
**Supersedes:** VisaItalyPK-Screens-v1.md
**Companion to:** VisaItalyPK-PRD-v3.md

**Total:** 45 screens — 29 user-facing (Flutter, Android) + 16 admin (Next.js on Cloudflare Pages)

**Delta from v1:** +11 new · 3 merged/removed · 1 onboarding step relocated

---

## Change Log (v1 → v2)

| Change | Detail |
|---|---|
| **ADDED** | Eligibility Quick Check (pre-auth, free) |
| **ADDED** | Today / Next Action |
| **ADDED** | My Documents (v1 linked it from Dashboard but no screen existed) |
| **ADDED** | How We Verify (trust surface) |
| **ADDED** | Order Confirmation (SLA countdown) |
| **ADDED** | Support Thread (in-app async chat) |
| **ADDED** | Refund Request (PRD §17 had policy, no user path) |
| **ADDED** | Admin Home / Overview |
| **ADDED** | Admin — Support Inbox |
| **ADDED** | Admin — User / Case Lookup |
| **ADDED** | Admin — Refund Queue |
| **MERGED** | Reminders + Updates → **Notification Center** (3 tabs) |
| **MERGED** | Nulla Osta Tracker → card inside Applicant Case View |
| **MOVED** | Language Select — out of onboarding, into Account/Settings |
| **REDUCED** | Document statuses 8 → 5; "Needs Review" becomes a badge, not a status |
| **NEW SCOPES** | `support_manage`, `refund_manage` |

---

## Locked Product Decisions (Phase 2.5)

| Decision | Resolution |
|---|---|
| Language | **English-first.** Urdu ships only when CMS content is 100% translated + RTL tested. Half-Urdu is worse than English-only. |
| Non-applicable checklist items | **Shown, greyed out, with reason** — not hidden. Visible personalization is the value proof. |
| Customer support | **In-app async thread** (own stack, €0 recurring). WhatsApp deep link = escape hatch for pre-auth/free users only. |
| Support scope | **Transactional only.** Requirement/eligibility questions get a CMS requirement link, never operator free-text. |
| Notifications | **One inbox**, three tabs. FCM is delivery only; Neon is source of truth. |
| Vocabulary | "Case" not "checklist". "Blocking" not "incomplete". No advisory language (see §Copy Rules). |

### SLA (all CMS-configurable, never hardcoded)

| Event | Public promise | Internal target |
|---|---|---|
| Payment verification | **12 working hours** | < 4 hrs |
| Support reply — paid | **24 working hours** | < 8 hrs |
| Support reply — free / pre-sales | **48 working hours** | — |

CMS keys: `sla_payment_hours`, `sla_support_paid_hours`, `sla_support_free_hours`, `working_hours_text`, `working_hours_windows`.
Working hours definition (e.g. Mon–Sat 09:00–18:00 PKT) must be **visible on-screen** wherever an SLA is stated.
UI shows a **computed deadline**, not the raw number: "Verified by Fri 2:00 PM" — calculated from submission timestamp against `working_hours_windows`.

---

## A. Auth & Onboarding (7)

### 1. Splash / Auth Check
**Function:** Resolve Firebase session → call `/me` for entitlement + onboarding state → route.
**Routes to:** Eligibility Quick Check (no session, first open) · Login (no session, returning) · Disclaimer Gate (session, onboarding incomplete) · Family Dashboard (session, complete)
**Notes:** Entitlement always resolved from Neon, never cached claims.

### 2. Eligibility Quick Check ⭐ NEW
**Function:** Pre-auth, no signup required. 4–6 questions (relationship, sponsor status in Italy, Nulla Osta status, applicant location). Returns a **non-committal readiness summary** + the top 3 things this profile typically needs.
**Routes to:** Login/Signup (CTA) · WhatsApp deep link (pre-sales questions)
**States:** Question flow · Result · Result + paywall teaser
**Notes:**
- This is the conversion hook. It is the only place value is delivered before any form-filling.
- **Copy constraint:** never outputs a verdict ("you are eligible", "you will qualify"). Outputs orientation only ("Spouse applications typically require…"). See §Copy Rules — this screen carries the highest §18 Risk #1 exposure.
- Answers are held in local state; persisted only after signup, then pre-fills screen 6.

### 3. Login / Signup
**Function:** Firebase Auth. Device registration on success (PRD §2 — max 2 devices, evict oldest on 3rd).
**Routes to:** Disclaimer Gate (new) · Splash re-check (returning)
**States:** Loading · auth error · device-evicted notice.

### 4. Disclaimer Gate
**Function:** Full legal disclaimer, blocking accept. Writes accepted version + timestamp to DB.
**Routes to:** Applicant Count
**Notes:** Cannot be skipped or back-navigated. Re-shown when disclaimer version changes.

### 5. Applicant Count
**Function:** 1 / 2 / 3 / 4+ selector. Determines how many times screen 6 repeats.
**Routes to:** Applicant Profile Setup

### 6. Applicant Profile Setup *(repeats per applicant)*
**Function:** Name/nickname, relationship (Spouse/Child/Parent), DOB where required, current location, applicant category, Nulla Osta status.
**Routes to:** Next applicant (loop) → Current Stage Select
**Notes:** Pre-filled from Eligibility Quick Check for applicant 1 where answers map. Each profile independent — requirements never merge across applicants.

### 7. Current Stage Select
**Function:** Per applicant — Planning / Nulla Osta in process / Nulla Osta received / Documents being prepared / Appointment-waiting-list / Submitted / Processing / Decision. Seeds the journey engine.
**Routes to:** Family Dashboard
**Notes:** On completion, journey engine generates the case **immediately** so the first Dashboard view is never empty.

---

## B. Core (8)

### 8. Family Dashboard `[HOME]`
**Function:** Per-applicant case cards (name, readiness %, current stage, blocking count) + combined readiness. Quick actions: My Documents · Translations · Appointment Assistance · Support · How We Verify.
**Header:** **Notification bell + unread badge** (persistent across all top-level screens).
**Routes to:** Today · Applicant Case View · all service flows · Notification Center · Support Thread · My Orders · Account
**States:** Free (limited) · Premium · **Grace-period read-only banner** (+ "Request renewal" CTA) · Offline ("Saved — will sync") · **Pending payment banner** (with live SLA countdown → Order Confirmation)
**Card copy pattern:** `Spouse · Nulla Osta received · 68% ready · 4 items blocking submission`

### 9. Today / Next Action ⭐ NEW
**Function:** The direct answer to PRD §1 Q2. Across all applicants, the top 3–5 actionable items right now, ranked: expiring soonest → blocking submission → unblocked-and-ready → waiting-on-us.
**Routes to:** Checklist Item Detail · Order Detail · Support Thread
**States:** Has actions · All clear ("Nothing needs you today — next: appointment window opens in 12 days") · Grace read-only
**Notes:** Ranking is **rule-based** (PRD §12), computed by the Cron Worker into a materialized `next_actions` row per applicant. Never computed on the request path — 10 ms CPU ceiling.

### 10. Applicant Case View
**Function:** Single applicant. Contains:
- Readiness bar + blocking count
- **Personalization line** — `23 requirements · 4 specific to Spouse category · 2 not applicable to you`
- **Nulla Osta card** (status, issue date, expiry, days remaining, expiry warning) — expand in place
- Case file list with **search + filter** (status, blocking, translation required, apostille required)
- Non-applicable items shown **greyed with reason**, not hidden
**Routes to:** Checklist Item Detail · Journey Timeline · How We Verify
**States:** Free (3 items + blurred count) · Premium (full) · Grace read-only
**Notes:** Nulla Osta validity period read from latest verified requirement, never hardcoded.

### 11. Checklist Item Detail ⭐
**Function:** Single merged screen — status selector, purpose, who provides it, where to obtain, translation/apostille flags, recommended timing, official source link, **"Verified N days ago" shown prominently (not in footer)**, and document upload/view inline.
**Routes to:** back to Applicant Case View · Translation flow (if translation flagged) · How We Verify
**Statuses (5):** Not Started · In Progress · Ready · Issue Found · Not Applicable
**Badges (not statuses):** `Needs Review` (offline conflict) · `Source updated — under review` (hash flag raised, admin re-verification pending) · `Blocking`
**Notes:**
- Merged from list-detail + upload — no navigation jump.
- Footer always shows "Verify with official source" + link (PRD §18).
- Not-applicable items render read-only with the rule reason: *"Required for Parent category — not applicable to your case."*

### 12. Journey / Stage Timeline
**Function:** All 8 stages, visual progress, current position, what comes next.
**Routes to:** Applicant Case View · Checklist Item Detail

### 13. Notification Center ⭐ NEW (replaces Reminders + Updates)
**Function:** Single persistent inbox. Bell icon + unread badge on all top-level screens. Three tabs:

| Tab | Contents | Generated by |
|---|---|---|
| **Reminders** | Document expiry, appointment dates, waiting-list actions, Nulla Osta expiry, missing documents, upcoming tasks | Cron Worker, from case data |
| **Updates** | Requirement changes affecting this account's applicants — what changed, source, change summary, effective date | Admin publish event (CMS) |
| **Activity** | Order status changes, payment approved/rejected, courier status, support replies, renewal decisions | Event trigger on status write |

**Routes to:** Checklist Item Detail · Order Detail · Support Thread · Applicant Case View
**States:** Unread · Read · Empty per tab · Offline (cached last sync)
**Notes:**
- **Neon is source of truth.** FCM push is delivery only — a missed or dismissed push must never lose the record.
- Every notification row: `type, title, body, deep_link_target, applicant_id?, order_id?, created_at, read_at`.
- Mark-read is a single cheap write; badge count is a single indexed count query. Both must stay well under the 10 ms CPU ceiling.
- Deep link is mandatory on every row — a notification that can't be acted on is noise.
- Update notifications carry the change summary inline so the value is felt without a tap: *"Changed 3 days ago. This affects your case."*

### 14. My Documents ⭐ NEW
**Function:** All uploaded files across all applicants — filter by applicant, document type, status. Shows which case item each file satisfies, upload date, expiry where applicable.
**Routes to:** Checklist Item Detail
**States:** Empty (with "start with your passport" prompt) · Populated · Grace read-only
**Notes:** v1 linked this from the Dashboard but no screen existed. Files live in R2, referenced from Neon (PRD §5).

### 15. How We Verify ⭐ NEW
**Function:** Explains the verification workflow, authoritative source policy, hash-change detection, and shows aggregate stats (`N requirements tracked · all source-linked · last sweep: today`). Includes recent update history.
**Routes to:** Checklist Item Detail (from any listed update)
**Notes:** This screen is not a feature — it is the price justification. Reachable from the paywall, from any item detail, and from the Dashboard.

---

## C. Services (9)

### 16. Premium Upsell / Paywall
**Function:** Triggered by blurred items or locked features. Per-person pricing from CMS (`99.99 + (n−1) × 94.99`), what's included/excluded, link to How We Verify.
**Routes to:** Checkout · How We Verify

### 17. Translation — Document Select
**Function:** CMS-driven document type list, per-document price, **quantity (+) control** per type. Running subtotal. Indicates whether translation appears necessary per verified requirements.
**Routes to:** Translation — Delivery Details

### 18. Translation — Delivery Details
**Function:** Courier delivery address collection + **courier fee as a separate line item** (CMS-priced) before payment.
**Routes to:** Checkout
**Notes:** Courier mandatory — no in-app-download alternative (physical documents).

### 19. Appointment Assistance — Request
**Function:** Applicant selection, per-person pricing (`70 + (n−1) × 65`), scope of assistance.
**Routes to:** Checkout
**Notes:** Zero guarantee language enforced — no slot representation (PRD §10).

### 20. Checkout `[SHARED — all 3 services]`
**Function:** Price breakdown by category (official / service-provider / VisaItaly PK / courier), refund terms, short disclaimer, **14-day withdrawal waiver checkbox**, referral credit application (Translation + Appointment only, never Premium), bank transfer details, generated order reference.
**Routes to:** Payment Proof Upload
**Notes:** Price snapshot written to the order row at this point.

### 21. Payment Proof Upload
**Function:** Screenshot upload → R2. Order status → `pending_verification`.
**Routes to:** Order Confirmation
**States:** Uploading · Upload failed (retry) · Success

### 22. Order Confirmation ⭐ NEW
**Function:** Post-upload landing. Order reference, amount, **computed verification deadline** ("Verified by Fri 2:00 PM"), working-hours statement, what happens next, and what to do if it's late (→ Support Thread).
**Routes to:** My Orders · Support Thread · Family Dashboard
**Notes:** This screen exists purely to kill the silence gap after payment. It removes the single largest predicted support volume driver.

### 23. My Orders
**Function:** All orders across services — service type, applicant/document, price, payment status, order status, date, reference ID. Status shown as a **timeline**, not a flat label.
**Routes to:** Order Detail
**States:** Empty · Populated

### 24. Order Detail
**Function:** Full breakdown, price snapshot, **PDF receipt** download, refund eligibility state + CTA, and for translation orders **courier tracking** (`dispatched → in-transit → delivered` + courier reference).
**Routes to:** Refund Request (when eligible) · Support Thread
**States:** Pending verification (with SLA countdown) · Paid · **Rejected — with admin reason + "Re-upload proof" CTA** · In progress · Dispatched · Delivered · Refunded
**Notes:** Courier status updated manually by admin at MVP — no carrier API. Rejection **must** carry a reason; a bare "Rejected" is a trust failure.

---

## D. Support, Referral & Account (5)

### 25. Support Thread ⭐ NEW
**Function:** Async in-app conversation. One thread per user, optionally scoped to an order or applicant. Text + image attachment (R2). Shows SLA promise + working hours. Unread state feeds the Notification Center Activity tab.
**Routes to:** Order Detail · Checklist Item Detail (via linked requirement) · WhatsApp deep link (fallback only)
**States:** Empty (with topic chips) · Awaiting reply (SLA countdown) · Replied · Closed
**Scope enforcement (critical — PRD §18 Risk #1):**
- Supported topics: payment status, order issue, courier, refund, account/device, app problem.
- **Requirement / eligibility questions are answered with a CMS requirement link via canned response — never operator free-text.** The verification system is the legal defense; free-text advice destroys it.
- Every thread carries the standard disclaimer footer.
- All messages stored in Neon → GDPR-deletable, audit-visible.
**Free vs Premium:** available to all, but free/unpaid users get **pre-sales topics only** (pricing, what's included, refund policy). Otherwise the €99.99 value leaks through support.

### 26. Refund Request ⭐ NEW
**Function:** Per-order refund request against PRD §17 rules. Shows eligibility computed from order status + elapsed time + tasks completed, reason selection, free-text note, submission, and status tracking (`requested → reviewed → approved/declined → refunded`).
**Routes to:** Order Detail · Support Thread
**Notes:** PRD §17 defined the policy but v1 gave the user no path to invoke it. With EU withdrawal rights in play (§17), an in-app request path is a compliance requirement, not a convenience.

### 27. Referral
**Function:** Personal referral code, share action, credit balance, referral history (who, status, credited amount).
**Routes to:** Withdrawal Request
**Notes:** Credit awarded only when the referee's order reaches `paid`.

### 28. Withdrawal Request
**Function:** Pakistani bank account form (name, account number, IBAN/branch code — stored once, reused), request amount, submission, status tracking (`requested → reviewed → approved → paid`).

### 29. Account / Settings
**Function:** **Language toggle (English / Urdu — Urdu gated behind CMS content-complete flag)**, notification preferences per channel, **active devices list** (2 max, sessions + eviction notice), privacy policy, terms version accepted, account/data deletion (GDPR), logout.
**Notes:** Language moved here from onboarding. Removing it from the onboarding flow cuts one screen from the pre-value form wall.

---

## E. Admin / CMS (16)

### 30. Admin Login
**Function:** Role-scoped authentication. Loads permission set → hides unauthorized nav.

### 31. Admin Home / Overview ⭐ NEW
**Scope:** any authenticated admin (contents filtered by scope)
**Function:** Post-login landing. Queue counts with **SLA-breach highlighting**: payments pending (and how many are past 12h), support threads awaiting reply (past SLA), hash flags open, payout requests, refund requests, renewal requests.
**Routes to:** every queue the admin has scope for
**Notes:** v1 had no admin landing screen. Without SLA visibility here, the SLA promise is unenforceable internally.

### 32. Super Admin — Role Management
**Scope:** `super_admin` only
**Function:** Create admins, assign/revoke granular permissions freely (any combination). Shows granted_by + granted_at per permission.

### 33. Order Queue — Payment Verification
**Scope:** `payment_approve`
**Function:** `pending_verification` orders sorted by SLA deadline, payment proof viewer, **one-click Approve** → single Postgres transaction sets `paid` + entitlement flags. Reject **requires a reason** (selected + optional note) which is surfaced verbatim to the user.

### 34. Refund Queue ⭐ NEW
**Scope:** `refund_manage`
**Function:** Refund requests with policy-eligibility pre-computed per PRD §17, approve/decline with mandatory reason, mark-refunded, audit-logged.

### 35. Support Inbox ⭐ NEW
**Scope:** `support_manage`
**Function:** All support threads, sorted by SLA deadline. Full user + case + order context in a side panel (no context-fetching by the operator). **CMS-managed canned responses**, including requirement-link responses. Assign, close, reopen.
**Notes:** Canned responses are CMS-driven — no hardcoding, and they are the mechanism that keeps support inside the transactional scope.

### 36. User / Case Lookup ⭐ NEW
**Scope:** `read_only` and above
**Function:** Search by email / order ref / referral code. Read-only view of account, applicants, case state, orders, devices, entitlement. Write actions still require the specific scope.
**Notes:** Every lookup is audit-logged — this screen exposes user data and is itself a privacy surface.

### 37. Translation Channel
**Scope:** `translation_manage`
**Function:** Translation orders, document list per order, status progression (`In Progress → Ready → Dispatched`), courier reference entry, delivery status updates.

### 38. Appointment Channel
**Scope:** `appointment_manage`
**Function:** Appointment assistance orders, status progression, assistance notes.
**Notes:** Kept fully separate from Translation Channel — different workflows, different operators.

### 39. Content / Requirement CMS
**Scope:** `verification_manage`
**Function:** Requirement CRUD, per-relationship-category rules, source metadata (URL, publication date, last verified), verification workflow states (`Created → Verified → Published → Reviewed → Updated/Archived`), verifier + timestamp on every transition.
**Notes:** Publishing an update **emits an Updates notification** to every affected applicant. This is the single highest-value notification in the product — it is what free competitors cannot do.

### 40. Hash-Change Flags Queue
**Scope:** `verification_manage`
**Function:** Daily Cron Worker output — source pages whose content hash changed. Re-verify action → updates `last_verified_date` or opens the requirement for edit.
**Notes:** While a flag is open, affected user-side items show the `Source updated — under review` badge. Honesty here is a trust asset, not a weakness.

### 41. Referral Payout Queue
**Scope:** `referral_payout` + `cash_dept`
**Function:** Withdrawal requests, user bank details, balance validation, status progression `requested → reviewed → approved → paid`. Abuse-review flags surfaced here.

### 42. Premium Expiry Confirmations
**Scope:** `expiry_manage`
**Function:** `visa_granted` self-confirmations awaiting verification, grace-period overrides (set/reverse/extend), **renewal requests** (approve → fresh access window, CMS-configurable duration). All audit-logged.

### 43. Pricing / CMS Config
**Scope:** `pricing_config`
**Function:** All prices (Premium base/additional, Appointment base/additional, per-document translation prices, courier fee), referral credit amount, grace period length, renewal duration, **all SLA values, working-hours windows, and the Urdu content-complete flag**. Zero hardcoding — changes take effect without an app release.

### 44. Disclaimer / Legal Version Manager
**Scope:** `legal_manage`
**Function:** Disclaimer + ToS versioning, publish new version (triggers re-accept on the user side), view acceptance records per version.

### 45. Audit Log Viewer
**Scope:** `read_only` and above
**Function:** All admin actions — actor, action, target, timestamp. Filterable. Required as legal defense (PRD §18). **Includes support messages, refund decisions, and case lookups.**

---

## Navigation Graph (text)

```
Splash
 ├─ first open, no session ──> ELIGIBILITY QUICK CHECK ──> Login/Signup
 ├─ returning, no session ───> Login/Signup
 │                                  │
 │                            Disclaimer ──> Applicant Count ──> Applicant Profile (xN)
 │                                                                        │
 │                                                              Current Stage Select
 │                                                                        │
 └─ session ────────────────────────────────> FAMILY DASHBOARD <──────────┘
                                                   │  [bell + badge in header]
        ┌──────────┬───────────┬──────────────┬────┴─────┬──────────┬─────────┬─────────┐
        │          │           │              │          │          │         │         │
     TODAY    Applicant   NOTIFICATION      MY DOCS   Referral  My Orders  SUPPORT   Account
        │     Case View     CENTER            │          │         │       THREAD   /Settings
        │          │      (Reminders/         │      Withdrawal    │
        │          │       Updates/           │       Request      │
        │          │       Activity)          │                    │
        └──> Checklist Item Detail <──────────┴────────────────────┤
                   │                                          Order Detail
                   ├──> Translation flow                      (courier tracking,
                   ├──> HOW WE VERIFY                          PDF receipt,
                   │                                           reject reason)
      Applicant Case View                                           │
        ├──> Journey Timeline                                  REFUND REQUEST
        └──> Nulla Osta card (in-place)

  SERVICE FLOWS (all converge on shared Checkout):
   Premium Paywall ─────────────────┐
   Translation: Doc Select ──> Delivery Details ──┤
   Appointment: Request ────────────┘
                    └──> CHECKOUT ──> Payment Proof Upload ──> ORDER CONFIRMATION ──> My Orders
                                                                (SLA countdown)
```

---

## Copy Rules (enforced, not stylistic)

**Premium presentation, never premium claims.**

| Use | Never use |
|---|---|
| "Your case" | "Your assessment" |
| "4 items blocking submission" | "4 items incomplete" |
| "Spouse applications typically require…" | "You are eligible" / "You will qualify" |
| "Verified 12 days ago" | "Guaranteed current" |
| "Source updated — under review" | (silence) |
| "Saved — will sync" | "Offline" |

Advisory-sounding vocabulary ("eligibility verdict", "recommended strategy", "we advise") increases PRD §18 Risk #1 exposure. **All user-facing copy — not just ToS — goes into the pre-launch lawyer review.** The Eligibility Quick Check screen carries the highest exposure and must be reviewed first.

---

## Motion & Polish Budget

~2 dev-days, applied app-wide. Highest perceived-value-per-hour item in the build:
- Shared-axis screen transitions (no hard jumps)
- Animated readiness bar (no snap)
- Status-change micro-animation on checklist items
- **Payment-approved unlock moment** — a full-screen state, not just a push notification
- Haptics on status change, approval, and submit

---

## Empty States (specified, not left to implementation)

| Screen | Empty state |
|---|---|
| Dashboard (new user) | Never empty — case generated at Stage Select |
| Today | "Nothing needs you today — next: appointment window opens in 12 days" |
| My Documents | "Start with your passport — it's needed at every stage" + upload CTA |
| Notification Center | Per tab: "You're up to date. We check official sources daily." |
| My Orders | "No orders yet" + the three services |
| Support Thread | Topic chips (payment · order · courier · account · app problem) |
| Referral | Code + share CTA, "€5 per successful referral" |

---

## Phase 3 Prerequisites

1. Courier partner selection — affects Order Detail tracking fields and Translation Channel status options
2. Confirm CMS defaults — referral credit (€5), grace renewal duration (1 month), SLA values (12/24/48), working-hours window
3. WhatsApp business number provisioned (pre-auth escape hatch only)
4. Lawyer review scope extended to **user-facing copy**, especially Eligibility Quick Check
5. Module build order: Auth + devices → Applicant profiles → Checklist engine → CMS/content → Notifications (Cron + FCM) → Payments → Services → Support → Referral → Admin RBAC

---

## Cost Impact vs v1

| Item | Recurring cost |
|---|---|
| Support thread (Neon + R2 + FCM, all existing) | **€0** |
| Notification Center (Neon + Cron + FCM, all existing) | **€0** |
| WhatsApp deep link (`wa.me`) | **€0** |
| All 11 new screens | **€0 recurring** |

Added build effort: ~6–8 dev-days. No new vendor, no new subscription, no change to the locked stack.
