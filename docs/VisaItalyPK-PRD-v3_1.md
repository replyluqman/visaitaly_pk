# VisaItaly PK — Product Requirements Document

**Version:** 3.1 (LOCKED)
**Date:** 03 Sep 2026
**Status:** Locked for Phase 3 (Implementation)
**Supersedes:** PRD v1, v2, v2.1 addendum, v3.0 — this is the single authoritative document.
**Companion to:** VisaItalyPK-Screens-v2.md

---

## Change Log (v3.0 → v3.1)

Stack, pricing, entitlement model, and legal posture are **unchanged**. All changes below come from Phase 2.5 review.

| § | Change |
|---|---|
| 8 | Support access boundary added to Free/Premium split |
| 9 | Payment SLA (12 working hours), Order Confirmation step, **mandatory rejection reason** |
| 10 | **New service section: Customer Support** — in-app async thread, transactional scope only |
| 11 | Language selection **moved out of onboarding** into Settings; **Eligibility Quick Check** added pre-auth |
| 11a | **New: Language Policy** — English-first, Urdu gated behind content-complete flag |
| 12 | Document statuses reduced **8 → 5**; `Needs Review`, `Source updated`, `Blocking` become **badges** |
| 13 | Open hash-flag state must be **surfaced to users** as a badge |
| 14 | Reminders + Updates consolidated into a single **Notification Center** (3 tabs), Neon-authoritative |
| 14a | **New: SLA Policy** — all values CMS-driven, UI shows computed deadlines |
| 16 | Two new scopes: `support_manage`, `refund_manage` |
| 17 | **In-app Refund Request path** added (policy existed, user path did not) |
| 18 | Lawyer review scope **extended to all user-facing copy**; Copy Rules made enforceable |
| 20 | MVP scope updated: support, notification centre, refund requests, eligibility check |
| 24 | Open items updated |

---

## 1. Product Overview

**Product:** VisaItaly PK — paid mobile app + optional paid assistance services
**Platform:** Android (MVP) → iOS (post-MVP)
**Market:** Pakistani applicants and the family members managing their applications
**Use case:** Italy Family Reunification Visa journey management

### Positioning

> Your step-by-step Italy Family Reunification Visa journey from Pakistan.

> Know what you need. Know what to do next. Track your progress. Get help when you need it.

### Core Principle

The app must always answer three questions:

1. What do I need?
2. What do I need to do now?
3. What comes after that?

The user should never have to hunt through information to find their next step.

**v3.1 note:** Q2 now has a dedicated surface — the **Today / Next Action** screen. In v3.0 this principle had no screen that directly answered it.

---

## 2. Users & Account Model

**One account = one user managing one or more applicants.**

The account holder is whoever holds login access. That person adds all applicants during onboarding and manages every applicant's profile, checklist, documents, uploads, and service orders directly. There is no secondary role, no per-applicant login, no account linking, and no cross-account permission model.

### Applicant Profiles

One account → many applicant profiles. Each applicant has an **independent** profile, checklist, progress, reminders, and service orders. Requirements must never merge across applicants.

### Relationship Categories

Spouse · Child · Parent — each with distinct requirement sets.

### Device Limit

Max **2 active devices** per account. On a 3rd login, the oldest active session (by `last_login`) is force-logged-out automatically — silent eviction, with a notice shown to the evicted device on next open.

---

## 3. Problem Statement

Applicants struggle because requirements are fragmented across sources, differ by relationship type, change without notice, and are commonly sourced from unofficial agents or social media.

**Evidence of the fragmentation problem (found during research):** Pakistan's Italy visa application centre appears to have changed provider — a newer centre lists Islamabad, Lahore, Faisalabad, Multan, Karachi and Quetta with a PKR service fee, while the older VFS Global page still shows a €30 service fee. Two official-looking sources, two different fees. This is exactly why the app must use a verified CMS layer, not live-embedded third-party pages.

---

## 4. Locked Tech Stack

**Unchanged from v3.0. Not open for re-litigation.**

| Layer | Choice | Free tier | Why |
|---|---|---|---|
| App | Flutter | Free | Single codebase, Android now / iOS later |
| DB | Neon Postgres | 0.5 GB storage, ~191 compute-hrs/mo | True Postgres, scale-to-zero, usage-based paid ramp (~$19/mo) |
| API | Cloudflare Workers | 100k req/day | Flat cheap paid tier ($5/mo → 10M req) |
| DB connection | Cloudflare Hyperdrive | Included in all Workers plans | Cloudflare-recommended for Neon; pooling + query routing |
| Storage | Cloudflare R2 | 10 GB | **Zero egress fees** — the real long-term cost saver |
| Auth | Firebase Auth | Unlimited users | Never becomes a cost line |
| Auth-in-Workers | `firebase-auth-cloudflare-workers` + `@hono/firebase-auth` | Free | Zero-dependency, Web Standard APIs only |
| Cron | Cloudflare Cron Triggers | Free | Bundled with Workers |
| CMS hosting | Cloudflare Pages | Free | Next.js admin |
| Push | FCM | Free | Unlimited |

**v3.1 confirms:** support threads and the notification centre introduce **no new vendor and no new recurring cost**. Both run on Neon + R2 + FCM + Cron, all already in the stack.

### Verified Compatibility (researched, not assumed)

- **Neon + Workers:** officially supported by Cloudflare as a third-party integration. Two paths: Hyperdrive (recommended) or `@neondatabase/serverless` driver over HTTP/WebSockets. With Hyperdrive, use `node-postgres` (pg) or `Postgres.js` — **not** the Neon serverless driver.
- **Firebase Auth + Workers:** `firebase-auth-cloudflare-workers` provides `verifyIdToken` using only Web Standard APIs. Hono middleware (`@hono/firebase-auth`) needs `projectId` + a Workers KV namespace for JWK caching.
- **R2 + Workers:** native binding, same platform, no integration risk.

### Verified Cloudflare Free-Tier Limits (researched Sep 2026)

| Limit | Workers Free | Workers Paid ($5/mo) |
|---|---|---|
| Requests | 100,000/day (resets 00:00 UTC, Error 1027 on exceed) | No daily cap; 10M included |
| **CPU time per request** | **10 ms** | 30 s default (up to 5 min) |
| Memory | 128 MB | 128 MB (not a paid upgrade) |
| Subrequests | 50/request | 10,000/request |
| Workers KV | 100k reads/day, **1,000 writes/day**, 1 GB | Higher, metered |

Cloudflare's own guidance: average Worker ≈ 2.2 ms CPU; **auth, SSR and large payload parsing typically consume 10–20 ms** — exactly what hits the Free plan's 10 ms ceiling. Cloudflare does not bill subrequests and charges no egress.

### API Budget Strategy

**Finding: request count is not the constraint — CPU per request is.**

At 500 DAU × ~20 calls/session ≈ 10,000 req/day, we sit far below the 100k cap. But every user-facing Worker does Firebase JWT verification **plus** Postgres response parsing, both CPU-heavy, against a 10 ms ceiling.

**Consequence: aggressive batching is counter-productive.** Collapsing 10 calls into 1 reduces request count (which we don't need) while raising that request's CPU (which we can't afford). A batched call that exceeds 10 ms CPU fails outright.

**Correct approach:**

1. **Client-side caching first** — checklist in Flutter local DB, delta sync only. Reduces requests *and* CPU.
2. **Keep user-facing Workers thin** — move PDF receipt generation, source hash checking, **next-action ranking, and notification generation** into Cron Workers, never the request path.
3. **Moderate batching only** — group 3–5 related queries, never 10+.
4. **Cache Firebase JWKs in Workers KV** — low write volume, safely under the 1,000 writes/day cap. **Do not use KV as general storage** — that write cap is the trap.
5. **Escape hatch:** if CPU becomes the blocker, Workers Paid ($5/mo) raises 10 ms → 30 s. Far cheaper than redesigning the stack.

### Mandatory Implementation Constraints

1. **Neon region must be co-located near Workers** — otherwise latency + compute-hour burn.
2. **Hyperdrive is required, not optional** — unpooled connections burn compute hours silently.
3. **Client-side caching over batching** — see API Budget Strategy above.
4. **No heavy work in the user-facing request path** — the 10 ms CPU ceiling is unforgiving.
5. **(v3.1)** Notification badge count and mark-read must be single indexed queries. Notification *generation* is Cron-only.

### Known Stack Risks

- `firebase-auth-cloudflare-workers` maintenance cadence is slow (last publish ~2 yrs). API surface is stable (JWT verification doesn't change). Alternatives exist if needed.
- Multi-provider stack = manual region alignment, no single dashboard.
- Neon free-tier compute hours are the first ceiling you will hit, not storage.

---

## 5. Single Source of Truth

**Problem being prevented:** entitlement written in three places (Neon / Firebase / R2) causes "paid but not unlocked" desync.

| System | Owns |
|---|---|
| **Neon** | Everything. Single source of truth for entitlement, orders, cases, content, **notifications, support messages**. |
| **Firebase Auth** | Identity only (uid). **Never** store premium status in custom claims. |
| **R2** | Blob files only (document uploads, payment proofs, support attachments). File URLs referenced from Neon rows. |
| **FCM** | **Delivery channel only.** A push is never the record. A missed, dismissed, or undelivered push must not lose information. |

**One-click approve:** CMS → Worker endpoint → one Postgres transaction. No writes to Firebase. App resolves entitlement via `/me` from Neon on every launch. Desync becomes structurally impossible.

---

## 6. Pricing (CMS-Driven, Zero Hardcoding)

**Unchanged from v3.0.**

### Formula

**First person = full price. Every additional person = discounted flat price.** Applies to Premium and Appointment Assistance.

### Premium App Access

| Persons | Total |
|---|---|
| 1 | €99.99 |
| 2 | €194.98 |
| 3 | €289.97 |
| 4 | €384.96 |
| 5 | €479.95 |

`total = 99.99 + (n − 1) × 94.99`

### Appointment Assistance

| Persons | Total |
|---|---|
| 1 | €70 |
| 2 | €135 |
| 3 | €200 |
| 4 | €265 |
| 5 | €330 |

`total = 70 + (n − 1) × 65`

### Translation

Per document. **No volume discount.** Each document type has its own CMS-set price. Users pick documents from a list with a **quantity (+) control** per document type. Courier fee is charged separately (§10).

### Customer Support

**Free.** Not a paid product, not an upsell. Scope is bounded by policy (§10), not by price.

### Pricing Rules

1. **Nothing hardcoded.** All prices live in CMS and take effect without an app release.
2. **Price snapshot on order.** The order row stores the price at purchase time. CMS price changes must never alter historical orders, receipts, or refund amounts.
3. **Adding a person later uses the additional rate.** A user with 2 paid applicants adding a 3rd pays €94.99 (Premium) / €65 (Appointment), not the first-person rate.
4. **Three fully separate paid products.** Separate price, order, payment record, receipt, refund policy, and status. Translation and Appointment fees are never bundled into Premium.

---

## 7. Premium Lifecycle

**Unchanged from v3.0.**

Premium is per-applicant and ends when that applicant's visa is granted. It does not affect other applicants under the same account.

### Confirmation Paths

| Trigger | Applicant status | Premium status |
|---|---|---|
| User self-confirms | `visa_granted` | `expired_pending_confirmation` |
| Admin confirms in CMS | `visa_granted_verified` | `expired` |

**Rules:**

1. **30-day grace period** after user self-confirmation before access ends. Grace period length is CMS-configurable.
2. **Admin can override at any time** — set, reverse, or extend, with an audit record of who changed it and when.
3. **Both paths are required.** User-only means nobody confirms (confirming costs them access). Admin-only means manually tracking every case.
4. **Expiry never triggers a refund.** A granted visa means the service was fully delivered — non-refundable.
5. **Data is retained, not deleted,** on expiry. The user keeps read access to order history and receipts.
6. Expiry is evaluated by the daily Cron Worker, never on the user-facing request path.

### Grace Period — Access Scope

During grace:

- **Read-only access to everything** the applicant already had — checklist, documents, orders, receipts, reminders, notifications. No feature is hidden or reduced. Stage 8 (Decision/Passport) post-decision guidance remains fully reachable.
- **No new writes** — cannot edit checklist status, cannot place new service orders for that applicant.
- **(v3.1)** Support thread remains fully writable during grace and after expiry. Cutting off support from a paying customer at the moment they may have a billing question is indefensible.

After grace ends:

1. User submits a **renewal request** (in-app CTA on the grace banner)
2. Request enters the CMS admin queue
3. Admin approves → fresh access window granted (**1 month default, CMS-configurable**)
4. Audit-logged: who requested, who approved, when, duration granted
5. **No auto-renewal** — always admin-gated, consistent with the manual-approve pattern used for payments and referral payouts

**Implementation:** an `is_expired_pending` boolean gates writes at applicant-profile level; renewal grants set a new `access_until` timestamp, evaluated by the same daily Cron Worker.

### Premium Includes

Personalized journey, applicant-specific checklist, relationship-specific requirements, progress tracking, document guidance, translation guidance, apostille guidance, reminders, Nulla Osta tracking, appointment guidance, application preparation guidance, common-problem guidance, official-source references, verified updates, change notifications.

### Premium Excludes

Government visa fees, official service-provider fees, translation charges, courier charges, appointment-assistance charges, apostille charges, travel expenses, legal representation, guaranteed approval, guaranteed appointment.

---

## 8. Free vs Premium Boundary

### Free

- **Eligibility Quick Check** (pre-auth, no signup) — orientation output only, never a verdict
- Full **Stage 1 — Eligibility** content
- First **3 checklist items** visible; remainder blurred with count ("+18 more documents")
- Read-only sample journey
- Basic official-source information
- **How We Verify** screen
- Premium feature explanation
- **Support — pre-sales topics only** (pricing, what's included, refund policy, app problems)

### Premium Only

Full personalized journey, complete checklist, progress tracking, Today/Next Action, reminders, source references, update notifications, Nulla Osta tracking, all service ordering, **support on case-specific transactional topics**.

**Support boundary rationale (v3.1):** support must never become a free channel for the personalized guidance Premium is sold on. Free users get commercial answers; paid users get transactional answers about their own case. Neither tier gets free-text requirement advice — that is a legal boundary (§10, §18), not a pricing one.

Rationale: demonstrate value to justify €99.99 without giving away the product. Blurred-with-count is the strongest conversion pattern here.

---

## 9. Payments — Manual Model (MVP)

No payment gateway at MVP.

1. User selects service + quantity → app calculates total from CMS pricing
2. App displays bank details + generated order reference
3. User transfers to company bank account
4. User uploads payment proof (screenshot) → stored in **R2**
5. **(v3.1) User lands on an Order Confirmation screen** showing the order reference, amount, a **computed verification deadline**, the stated working-hours window, and what to do if it is late
6. Order lands in CMS admin queue as `pending_verification`
7. Admin verifies and clicks **Approve** (single click)
8. One Postgres transaction: `orders.status = 'paid'` + entitlement flags set
9. **(v3.1)** Approval emits a push + an Activity notification; the app shows a full-screen unlock state on next open
10. App reads entitlement on next `/me` call → unlocked
11. PDF receipt generated and made available under My Orders

### Verification SLA (v3.1)

**Public promise: 12 working hours. Internal target: under 4 hours.** CMS-configurable (§14a).

48 hours was considered and rejected: at a typical Mon–Sat 09:00–18:00 window that resolves to roughly five calendar days of a locked product after payment. That is the highest-risk window in the entire product for refund disputes and trust loss. Approval is a single admin click (step 7) — a long SLA is not defensible against the work involved.

### Rejection (v3.1)

A rejection **must** carry a reason, selected from a CMS-managed list plus an optional note, and that reason is surfaced verbatim to the user alongside a direct "re-upload proof" action. A bare `Rejected` state is prohibited.

### Accepted Risks

No chargeback protection, no automated dispute trail, does not scale past ~dozens of orders/month without admin load. Conscious MVP tradeoff — revisit before scale.

---

## 10. Services

### Translation

**Flow:** open Translations → select document types from CMS-driven list with **quantity (+) control** → provide delivery details → see per-document price, courier fee, and total → place order → separate payment → track status → receive delivery by courier.

The app must indicate whether translation appears necessary based on currently verified requirements before purchase.

**Courier delivery (mandatory, MVP):**

- Courier is the delivery method for completed translations — physical documents require physical return.
- Courier fee is a **separate line item**, CMS-priced, shown to the user **before payment**. Never blended into translation pricing (§14 Cost Display Rules).
- User provides delivery address during the Translation order flow.
- Order Detail shows courier status: `dispatched → in-transit → delivered`, plus courier reference number. Status is updated manually by admin at MVP — no live carrier API integration.

### Appointment Assistance

Administrative guidance for the applicable appointment/waiting-list process, subject to the rules of the relevant authority.

**Prohibited claims (absolute):** guaranteed appointment, guaranteed date, priority access, embassy connection, special influence, fast-track, appointment slots for sale, guaranteed visa.

Never sell or represent an appointment slot as a product.

### Customer Support (v3.1 — new)

**Model:** in-app asynchronous message thread. One thread per user, optionally scoped to an order or applicant. Text + image attachment (R2). Free for all users.

**Why in-app and not WhatsApp.** WhatsApp was evaluated and rejected as the primary channel on three grounds, none of them cost:

1. **No audit trail.** §16 requires every admin action to be audit-logged. Operator messages sent from a phone never reach Neon. In a refund dispute or regulatory complaint there is no record.
2. **GDPR (§19).** A data-deletion request cannot be honoured for message history held on a third-party consumer platform outside our systems.
3. **Advice risk (§18 Risk #1).** Free-form messaging invites unsourced, unversioned requirement advice. The entire verification system (§13) exists as legal defence; an operator typing *"you'll need this document"* with no source destroys it.

The in-app thread runs on Neon + R2 + FCM + the existing Next.js admin — **no new vendor, no new recurring cost.**

**Scope — enforced, not advisory:**

| In scope | Out of scope |
|---|---|
| Payment / verification status | Requirement or eligibility advice |
| Order issues, courier, delivery | "Will I get the visa?" |
| Refunds | Case strategy or recommendations |
| Account, device sessions | Anything not source-backed |
| App problems / bugs | Legal or immigration advice |

**Requirement and eligibility questions are answered with a CMS requirement link via a canned response — never operator free-text.** Canned responses are CMS-managed (`support_manage`), so the boundary is enforced by tooling rather than operator discipline.

Every thread carries the standard disclaimer footer (§18).

**WhatsApp — retained as escape hatch only.** A `wa.me` deep link is offered on the Eligibility Quick Check and to unauthenticated/pre-sales users. No case data exists in that context, so the legal exposure is near zero. Every authenticated user's support path is the in-app thread.

**Reply SLA:** 24 working hours paid, 48 working hours free (§14a). Both CMS-configurable.

**Volume note:** the single largest predicted support driver is *"I paid — when will it unlock?"* That is an order-status question, not a support question. The Order Confirmation screen and the 12-hour payment SLA (§9) are the correct fix; support is not a patch for missing status transparency.

---

## 11. Onboarding

1. **Eligibility Quick Check** *(pre-auth, optional, no account required)* — 4–6 questions returning an orientation summary and the top items this profile typically needs. This is the only value delivered before any form-filling, and the primary conversion surface.
2. **Signup / login** — Firebase Auth, device registration (§2)
3. **Disclaimer gate** — full legal disclaimer, blocking accept, **version-stamped in DB**
4. **Number of applicants** — 1 / 2 / 3 / 4+ (4+ supports adding individually)
5. **Applicant profiles** — name/nickname, relationship, DOB where required, current location, applicant category, Nulla Osta status. Applicant 1 is pre-filled from the Eligibility Quick Check where answers map.
6. **Current stage selection** — Planning / Nulla Osta in process / Nulla Osta received / Documents being prepared / Appointment-waiting-list / Submitted / Processing / Decision

On completion of step 6 the journey engine generates the case **immediately**, so the first Dashboard view is never empty.

**Removed from onboarding (v3.1):** language selection. It now lives in Account/Settings (§11a). v3.0 placed seven screens between app-open and any delivered value; that is a conversion wall in front of a €99.99 product.

Collect the minimum necessary. No unnecessary personal data.

---

## 11a. Language Policy (v3.1 — new)

**English-first. Urdu ships only when it is complete.**

Urdu remains a committed feature, gated behind a CMS `urdu_content_complete` flag. The toggle does not appear to users until that flag is set.

Blocking conditions before Urdu can be enabled:

1. **100% of CMS requirement content translated.** Partial translation produces a mixed-script app, which reads as amateur and undermines the premium positioning more than English-only does.
2. **RTL layout tested across every screen.** Flutter provides RTL support but not correct layout for free.
3. **Number, date, currency and reference-ID rendering decided.** Mixed-script numerals inside otherwise-Urdu sentences is the most common failure mode.

Ownership of translation and a target date are open items (§24).

---

## 12. Journey & Checklist Engine

### Process Stages

1. Understand Eligibility
2. Nulla Osta
3. Document Preparation
4. Translation / Legalization
5. Appointment Process
6. Visa Application
7. Processing
8. Decision / Passport

Journey adapts dynamically by applicant type, relationship, and case data. **Rule-based, not AI.**

### Checklist Item Structure

Document name, required/conditionally-required, purpose, who provides it, where to obtain it, translation requirement, apostille/legalization requirement, recommended timing, status, official source, last verified date.

### Document Status States (v3.1 — reduced 8 → 5)

**Not Started · In Progress · Ready · Issue Found · Not Applicable**

`Needed` and `Completed` were removed. `Needed` was indistinguishable from `Not Started` in practice, and users could not reliably tell `Ready` from `Completed`. Every ambiguous status is a support ticket.

### Badges (v3.1 — not statuses)

Orthogonal to status, and multiple can apply at once:

| Badge | Meaning |
|---|---|
| `Blocking` | This item blocks submission |
| `Needs Review` | Offline mutation conflict (see below) |
| `Source updated — under review` | An open hash flag exists for this requirement (§13) |

v3.0 modelled `Needs Review` as a status, which made it mutually exclusive with the user's actual progress state — the item's real status was lost while the conflict was pending.

### Non-Applicable Items — Display Rule (v3.1)

Items that the rule engine determines do not apply are **shown, greyed out, read-only, with the reason stated** — for example *"Required for Parent category — not applicable to your case."* They are **not hidden.**

Rationale: the entire technical and legal investment in the rule engine (§12) and verification system (§13) is personalization. If non-applicable items are hidden, the user sees only a shorter list and the work is invisible. Showing the exclusion with its reason is the clearest available proof that the system understands their specific case — and it is what a €99.99 price has to be justified by.

### Offline Cache & Conflict Resolution

Only the checklist is cached offline — conflict surface is narrow by design.

- Server-side requirement metadata (name, purpose, translation/apostille flags, source) **always wins** — never overwritten by client cache.
- User status changes made offline are queued as pending mutations.
- On reconnect, a mutation is applied **only if** its checklist item is unchanged server-side since last sync.
- If the item was modified or removed server-side while offline, the mutation is **not silently applied** — the item is flagged with the **`Needs Review`** badge.
- No merge UI at MVP. A non-blocking banner — *"X items updated while you were offline"* — surfaces affected items for individual review.
- **(v3.1)** Offline state is communicated as *"Saved — will sync"*, not *"Offline"*. The user needs to know their work is safe, not that the network failed.

---

## 13. Official Source & Content Verification

### Why Not Live-Embed Official Pages

Researched and rejected:

- **No official API exists.** Requirements live in scattered PDFs and HTML one-pagers. Scraping is fragile and carries ToS risk.
- **Sources actively contradict each other** (see §3). Live embedding would surface contradictory or wrong data.
- **Consulates explicitly disclaim liability** for changes made without notice. Live-pulling transfers that liability onto us.
- **Live embed destroys the product.** The core value is relationship-specific personalization. Embedding a PDF makes this a link-opener nobody pays €99.99 for.

### Chosen Approach — Change Detection

- Every requirement stores `source_url` + `last_verified_date` in CMS
- A **Cloudflare Cron Worker** performs a daily **content hash check** on source pages
- On hash change → admin gets a "source changed — re-verify" flag
- We copy nothing; we only detect change. Solves ~90% of the staleness problem with no scraping/legal exposure

### Open Flag State — User-Facing (v3.1)

While a hash flag is open and unresolved, affected checklist items display the **`Source updated — under review`** badge.

v3.0 left this state undefined on the user side, which meant a known-possibly-stale requirement was presented as current. Surfacing it is both the honest position and a trust asset: it is visible proof that sources are actually being monitored.

### Trust Surface (v3.1)

The verification system is the product's primary differentiator and must be visible, not buried:

- `Verified N days ago` appears **prominently** on every checklist item, not only in a footer line.
- A **How We Verify** screen documents the workflow, the authoritative-source policy, hash-change detection, aggregate coverage stats, and recent update history. It is reachable from the paywall, from any item detail, and from the Dashboard.
- Requirement-change notifications state the impact plainly: *"Changed 3 days ago. This affects your case."* This is the single capability free alternatives cannot replicate.

### Source Metadata (per requirement)

Source name, source URL, source document/page, publication date, last verified date, applicable applicant category, requirement version, internal verification status.

### Verification Workflow

`Created → Verified → Published → Reviewed → Updated/Archived`

Records who verified and when. **Critical requirements can never change without updating their verification record.**

Publishing an update emits an Updates notification to every affected applicant (§14).

### Authoritative Sources Only

Italian Embassy/consular authorities, relevant Italian government authorities, official visa-service-provider information. Blogs, agents, social media, and scraped sites are never authoritative.

---

## 14. Notifications, Reminders, Updates & Cost Display

### Notification Centre (v3.1 — consolidates Reminders + Updates)

A **single persistent inbox**, reachable from a bell icon with an unread badge present on all top-level screens. Three tabs:

| Tab | Contents | Generated by |
|---|---|---|
| **Reminders** | Document expiry, appointment dates, waiting-list actions, Nulla Osta expiry, missing documents, upcoming tasks | Cron Worker, from case data |
| **Updates** | Requirement changes affecting this account's applicants — what changed, source, change summary, effective date | Admin publish event (CMS) |
| **Activity** | Order status changes, payment approved/rejected, courier status, support replies, renewal decisions | Event trigger on status write |

v3.0 had Reminders and Updates as separate screens with overlapping content and badges in a third place. Three inboxes for one concept is a usability and trust problem.

**Rules:**

1. **Neon is the source of truth.** FCM push is a delivery channel only. A push that is missed, dismissed, or never delivered must never result in lost information — the user can always open the inbox and read it later.
2. **Every notification is persisted** with read/unread state: `type, title, body, deep_link_target, applicant_id?, order_id?, created_at, read_at`.
3. **Deep link is mandatory on every row.** A notification that cannot be acted on is noise.
4. **Generation is Cron-only** (reminders) or event-triggered on an existing write (activity). Never computed on the user-facing request path — 10 ms CPU ceiling (§4).
5. **Badge count is a single indexed count query; mark-read is a single write.** Both must stay well within CPU budget.
6. Update notifications carry the change summary inline so the value registers without a tap.
7. Per-channel notification preferences live in Account/Settings.

### Reminders

Document expiry, appointment dates, waiting-list actions, Nulla Osta expiry, missing documents, upcoming tasks, requirement updates. Dates calculated from actual case data.

### Updates

Updated requirement, updated source, last verified date, change summary, effective date. Users are notified of changes affecting their case.

### Nulla Osta Tracking

Record status, issue date, expiry date, related applicant → show days remaining + warn before expiry. **Validity period comes from the latest verified requirement, never a hardcoded constant.**

Presented as an expandable card inside the Applicant Case View rather than a standalone screen.

### Cost Display Rules

Four strictly separated categories:

1. **Official / Government fees**
2. **Service-provider fees**
3. **VisaItaly PK services**
4. **Courier fees**

No VisaItaly PK or third-party fee may ever be presented as an official government fee. All changeable prices come from CMS.

---

## 14a. SLA Policy (v3.1 — new)

| Event | Public promise | Internal target |
|---|---|---|
| Payment verification | 12 working hours | < 4 hrs |
| Support reply — paid user | 24 working hours | < 8 hrs |
| Support reply — free / pre-sales | 48 working hours | — |

**Rules:**

1. **Every value is CMS-driven, none hardcoded.** Keys: `sla_payment_hours`, `sla_support_paid_hours`, `sla_support_free_hours`, `working_hours_text`, `working_hours_windows`.
2. **The working-hours definition must be visible on-screen** wherever an SLA is stated. Without it, a user waiting through a Sunday concludes the business has disappeared.
3. **The UI shows a computed deadline, not a raw duration** — *"Verified by Fri 2:00 PM"*, calculated from the submission timestamp against `working_hours_windows`. Same promise, materially better experience.
4. **SLA breach must be visible internally.** The Admin Home screen highlights queue items past their deadline. An SLA with no internal visibility is not a commitment.

---

## 15. Dashboard, Orders, Referral

### Family Dashboard

Per-applicant case cards (name, readiness %, current stage, blocking count) + combined readiness across all applicants. Quick actions: My Documents · Translations · Appointment Assistance · Support · How We Verify. Notification bell + unread badge in the header.

Card copy pattern: `Spouse · Nulla Osta received · 68% ready · 4 items blocking submission`

### Today / Next Action (v3.1)

The direct answer to §1 Q2. Across all applicants, the top 3–5 actionable items right now, ranked: expiring soonest → blocking submission → unblocked-and-ready → waiting-on-us. Ranking is rule-based and materialized by the Cron Worker into a `next_actions` row per applicant — never computed on the request path.

### My Orders

Per order: service, applicant/document, price, payment status, order status, date, reference ID, **PDF receipt**, courier tracking (translation orders), refund eligibility state. Status is presented as a timeline, not a flat label.

### Referral

**Reward:** €5 (CMS-configurable) per successful referral. "Successful" = a referred user's order reaches `paid` status — never signup alone.

**Usage:** credit is usable **in-app** toward Translation or Appointment orders — **never** toward Premium (protects Premium price integrity) — or withdrawn as cash.

**Withdrawal flow:**

1. User requests withdrawal → provides Pakistani bank account (name, account number, IBAN/branch code), stored once and reused
2. Request enters queue → visible to **both** the cash-department role and admin role in CMS
3. Approval moves status `requested → reviewed → approved → paid`
4. Payout made manually to the provided bank account, marked paid, audit-logged

**Abuse guard:** one credit per unique `paid` order. Shared device_id, shared payout bank account, or repeated referral patterns raise a **manual review flag** — not an auto-block, to avoid false positives on legitimate family referrals.

---

## 16. Admin Roles & Permissions (RBAC)

- `super_admin` — full access; the only role that can create other admins and assign permissions.
- All other admins receive **granular, independently assignable permission scopes**, freely combinable by `super_admin`:

| Scope | Grants |
|---|---|
| `payment_approve` | Order Queue / Payment Verification |
| `translation_manage` | Translation Channel |
| `appointment_manage` | Appointment Channel |
| `verification_manage` | Content/Requirement CMS + verification workflow + hash-flag queue |
| `referral_payout` | Referral Payout Queue |
| `cash_dept` | Withdrawal request review (bank payout) |
| `pricing_config` | Pricing / CMS Config (incl. SLA values, working hours, Urdu flag) |
| `legal_manage` | Disclaimer / Legal Version Manager |
| `expiry_manage` | Premium Expiry Confirmations + grace overrides |
| **`support_manage`** *(v3.1)* | **Support Inbox + canned-response management** |
| **`refund_manage`** *(v3.1)* | **Refund Queue — approve/decline/mark refunded** |
| `read_only` | View-only across admin screens including User/Case Lookup, no write actions |

All admin actions are written to an audit log (actor, action, target, timestamp) regardless of role — required as legal defense (§18).

**(v3.1)** The audit log explicitly includes **support messages sent, refund decisions, and user/case lookups.** Case lookup is itself a privacy surface and must be logged even though it is read-only.

---

## 17. Refund Policy

| Service | Rule |
|---|---|
| **Premium** | 7-day refund if fewer than 3 tasks completed. Non-refundable thereafter (digital product consumed). |
| **Translation** | Full refund before order moves to `In Progress`. Non-refundable once processing starts; non-refundable once dispatched by courier. |
| **Appointment Assistance** | Full refund before work starts. Non-refundable once assistance begins. |

⚠️ **EU consumer law:** digital content carries a 14-day withdrawal right unless the user explicitly waives it. Users are frequently EU-resident, so this likely applies. Checkout must include an explicit **"I waive my 14-day withdrawal right"** checkbox. **Requires lawyer review before public launch — non-negotiable.**

Refund terms must be displayed before every purchase.

### Refund Request Path (v3.1 — new)

v3.0 defined the policy but gave the user no way to invoke it. With EU withdrawal rights in play, an in-app request path is a compliance requirement, not a convenience.

1. An in-app **Refund Request** is reachable from Order Detail whenever the order is eligible under the rules above
2. Eligibility is **computed and displayed** from order status + elapsed time + tasks completed — the user is never left guessing
3. Reason selection (CMS-managed list) + optional free-text note
4. Request enters the **Refund Queue** (`refund_manage`)
5. Status tracked: `requested → reviewed → approved/declined → refunded`
6. Approve and decline both require a reason, surfaced to the user, and are audit-logged

---

## 18. Legal & Compliance

### Mandatory Statements

> VisaItaly PK is an independent informational and administrative assistance service. It is not affiliated with, endorsed by, or operated by the Embassy of Italy, the Government of Italy, or any official visa authority/service provider.

> Visa requirements and procedures may change. Users should verify the latest requirements through the referenced official source before submitting an application.

### Does Not Provide

Legal representation · immigration-law advice · guaranteed approval · guaranteed appointment · decision prediction.

### Disclaimer Placement

| Location | Content |
|---|---|
| Onboarding | Full disclaimer, blocking accept, **version-stamped** |
| Eligibility Quick Check | Short disclaimer — orientation only, not an eligibility determination |
| Every paid checkout | Short disclaimer + refund terms + withdrawal-waiver checkbox |
| Every checklist screen footer | "Verify with official source" + source link |
| Every support thread | Standard disclaimer footer |

Version stamping exists so we can prove which terms version a user accepted.

### Copy Rules (v3.1 — enforceable, not stylistic)

**Premium presentation, never premium claims.**

| Use | Never use |
|---|---|
| "Your case" | "Your assessment" |
| "4 items blocking submission" | "4 items incomplete" |
| "Spouse applications typically require…" | "You are eligible" / "You will qualify" |
| "Verified 12 days ago" | "Guaranteed current" |
| "Source updated — under review" | (silence) |
| "Saved — will sync" | "Offline" |

The left column raises perceived value at zero engineering cost. The right column of the *prohibited* examples — verdict language, guarantees, "recommended strategy", "we advise" — increases Risk #1 exposure below.

### Identified Legal Risks

1. **Unauthorized immigration advice** — relationship-specific checklists are functionally advice even without guarantees. The source-verification system (§13) is a legal defense, not a feature. Do not cut it under time pressure. **(v3.1)** Two surfaces raise this exposure and must be treated as high-risk: the **Eligibility Quick Check** (§11) and the **support thread** (§10). Both are constrained by policy above; those constraints are legal controls, not UX preferences.
2. **Consumer protection (PK + IT)** — outdated paid content invites refund disputes and regulatory complaints.
3. **GDPR** — EU-resident users mean GDPR applies regardless of company location. Requires explicit consent flow + working data deletion. **(v3.1)** Deletion must cover support messages and support attachments in R2 — a further reason support does not live on a third-party platform.
4. **Manual payment disputes** — no chargeback protection, no automated evidence trail. **(v3.1)** Mandatory rejection reasons (§9) and the refund request trail (§17) partially mitigate.
5. **"Common Problems" content** — never assert a document/process causes refusal without an authoritative source. Enforce as a CMS content rule, not a guideline.

**A one-time lawyer review is required before public launch.** **(v3.1)** Its scope now covers **all user-facing copy**, not only ToS, liability limitation, jurisdiction, and refund/withdrawal terms. The Eligibility Quick Check output and the support canned-response library must be reviewed first. This remains the one line item not covered by free tiers.

---

## 19. Privacy & Security

Collect only what the selected service needs. Document uploads, payment proofs, and support attachments are stored in R2 and referenced from Neon.

Requirements: secure authentication · encrypted communication · minimal data collection · secure order records · access control · privacy policy · account/data deletion (**including support threads, messages, attachments, and notification history**) · no data selling · no card data stored by us · device session limit enforcement (§2) · **audit-logged admin access to user data via Case Lookup (§16)**.

---

## 20. MVP Scope

### In Scope

Auth · multi-applicant profiles under one account · device limit (2) · **pre-auth eligibility quick check** · journey engine · checklist engine (5 statuses + badges) · **non-applicable items shown with reason** · offline checklist cache with conflict resolution · **Today / Next Action** · custom CMS + verification workflow · source hash change detection **+ user-facing under-review badge** · **How We Verify screen** · **notification centre (3 tabs) + FCM push** · manual payment + one-click unlock · **order confirmation + payment SLA + mandatory rejection reasons** · PDF receipts · **in-app refund requests** · reminders · Nulla Osta tracker · translation orders with courier delivery + tracking · appointment orders · **in-app support thread (transactional scope)** · dashboard · **English (Urdu gated behind content-complete flag)** · referral codes with credit + manual bank withdrawal · admin RBAC · audit log · **admin home, support inbox, refund queue, case lookup**

### Out of Scope

AI document verification · approval prediction · auto form-filling · embassy API/system integration · OCR · legal advice/representation · any guarantee · complex document vault · unofficial scraping · WhatsApp reminders · **WhatsApp as primary support channel** · live courier carrier API · payment gateway · **live/synchronous chat** · **Urdu at launch**

### Post-MVP

iOS · WhatsApp reminders · family collaboration · secure document vault · OCR · AI document organization · apostille service · live courier tracking integration · payment gateway · more visa categories · more countries · **Urdu localization** · **live chat if async volume justifies it**

---

## 21. Success Metrics

**Primary:** paid conversion > 8% · journey completion > 40% · low refund rate · high checklist completion · high returning-user rate

**Quality:** 100% of critical requirements source-linked · 100% with verification records · low outdated-content incidents · low support requests from unclear instructions

**(v3.1) Operational:** payment verification within SLA > 95% · support first-reply within SLA > 95% · share of support volume that is order-status related (target: falling — a rising share means the Order Confirmation screen is not doing its job) · **eligibility-check → signup conversion** · **signup → first-purchase conversion**

**Business:** premium conversion · appointment conversion · translation conversion · ARPU · avg services revenue per account

---

## 22. Risks & Mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Rules change | CMS + verification + hash change detection |
| 2 | Incorrect information | Official-source-first policy + verification workflow |
| 3 | Price resistance | Personalized case management, not generic info; visible verification; visible personalization (§12 non-applicable display) |
| 4 | Appointment service perception | Clear separation, zero guarantee language |
| 5 | Translation quality | Qualified providers, defined scope |
| 6 | Legal/compliance | Disclaimers, transparency, lawyer review incl. all user-facing copy |
| 7 | Free competition | Personalization, verified updates, change notifications, workflow, reminders |
| 8 | Neon compute exhaustion | Hyperdrive pooling mandatory + client-side caching |
| 8b | Workers 10 ms CPU ceiling | Thin request path, heavy work in Cron Workers, $5/mo Paid as escape hatch |
| 9 | Manual payment doesn't scale | Accepted for MVP; gateway revisit before scale |
| 10 | Referral credit abuse | One credit per unique paid order + manual review flags |
| 11 | Courier loss/damage of original documents | Defined provider, tracking reference on every order, liability stated in ToS (lawyer review) |
| 12 | Narrow market | Target the family member who manages and pays, in messaging |
| **13** | **Support becomes an advice channel** *(v3.1)* | **Scope policy (§10) + CMS canned responses + requirement-link-only answers + full audit logging** |
| **14** | **Post-payment silence drives disputes** *(v3.1)* | **Order Confirmation screen + 12h SLA + computed deadline + push on approval + mandatory rejection reasons** |
| **15** | **Support volume exceeds one operator** *(v3.1)* | **Async by design (no live-chat expectation) + status transparency removes the largest driver + SLA-sorted inbox; scoped operators can be added via `support_manage`** |
| **16** | **Half-finished Urdu damages positioning** *(v3.1)* | **`urdu_content_complete` CMS flag gates the toggle entirely (§11a)** |

---

## 23. Definition of MVP Success

A user can:

1. Get a useful orientation before creating an account
2. Create an account and add one or more applicants
3. Select the correct relationship/category per applicant
4. Receive a personalized journey per applicant
5. See the relevant document checklist — including what does **not** apply to them, and why
6. Understand each document's purpose
7. Upload and track documents
8. Track completed tasks
9. Know what to do today without hunting
10. Receive important reminders and read them later from a persistent inbox
11. Access verified official-source information and see how it is verified
12. See requirement updates and understand their impact
13. Pay, know exactly when it will be verified, and be told why if it is rejected
14. Purchase translation separately, with courier delivery and tracking
15. Request appointment assistance separately
16. Reach a human about an order, payment, or account issue — for free
17. Request a refund in-app when eligible
18. Track overall progress across all applicants
19. Earn and withdraw referral credit

...without the product presenting itself as a government authority or promising any visa outcome.

---

## 24. Open Items for Phase 3

- Courier partner/provider selection and contracted liability terms
- Confirm CMS defaults: referral credit (€5), grace renewal duration (1 month), **SLA values (12 / 24 / 48)**, **working-hours window (proposed: Mon–Sat 09:00–18:00 PKT)**
- **WhatsApp business number provisioned** (pre-auth escape hatch only)
- **Support canned-response library drafted** — must exist before support goes live; it is the enforcement mechanism for §10 scope
- **Urdu translation ownership and target date** (§11a)
- **Lawyer review scope extended to user-facing copy**, Eligibility Quick Check reviewed first
- Screen list is locked — see VisaItalyPK-Screens-v2.md (45 screens: 29 user + 16 admin)

---

## 25. Timeline

**Target: 6–8 weeks**, plus approximately **1–1.5 weeks** for the v3.1 additions (support thread + inbox, notification centre, refund path, eligibility check, admin home/lookup, polish pass). No new vendor, no new recurring cost.

Content verification runs in parallel with development and must begin before development completes.

Workstreams: architecture · UI/UX · auth + device sessions · applicant profiles · journey engine · checklist engine + offline sync · CMS · verification system · **notification centre + Cron generation + FCM** · payments **+ SLA/confirmation** · translation orders + courier · appointment orders · **support thread + admin inbox** · **refund path** · referral + payouts · admin RBAC panel · analytics · QA/security · legal/privacy.

**Build order:** Auth + devices → Applicant profiles → Checklist engine → CMS/content → Notifications (Cron + FCM) → Payments → Services → Support → Referral → Admin RBAC.
