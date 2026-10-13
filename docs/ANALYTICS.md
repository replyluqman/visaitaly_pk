# Analytics — event plan

**Tool:** Firebase Analytics (GA4), already in the stack, free. **Server-side truth**
(orders, payments, refunds, SLA) comes from Neon via SQL, not from client events —
client analytics is for funnels and behaviour only, and can be blocked or lost.

**Consent:** collection is enabled only when `consents.analytics = true`
(`setAnalyticsCollectionEnabled`). Pre-auth (Eligibility Quick Check) runs with a
one-line notice + toggle on first open. EU users default to off until they accept.

## Naming rules

- `snake_case`, verb-last: `checkout_started`, not `startCheckout`.
- ≤ 40 chars, ≤ 25 params per event (GA4 limits — verify current limits before adding many custom dimensions).
- **No PII in any param**: no names, emails, phone, IBAN, free text. IDs only where
  listed, and only internal UUIDs — never Firebase uid.
- One event = one meaning. Never re-purpose an event; add a new one.
- Every event carries user properties (set once, updated on change):
  `app_version`, `locale`, `perf_tier`, `access_level` (best of the account's applicants),
  `applicant_count`, `onboarding_state`.

## Funnels → PRD §21 metrics

| Metric (PRD §21) | Numerator / denominator |
|---|---|
| Eligibility-check → signup | `signup_completed` / `eligibility_check_completed` |
| Signup → first purchase | `order_placed{service}` first per user (server) / `signup_completed` |
| Paid conversion > 8% | users with a `paid` premium order (server) / signups (server) |
| Journey completion > 40% | applicants reaching `decision` stage (server, `applicant_stage_events`) / applicants |
| Checklist completion | `ready` / applicable per applicant (server) |
| Returning users | GA4 retention (D1/D7/D30) |
| Payment verification within SLA > 95% | orders `paid_at <= verification_due_at` (server) |
| Support first reply within SLA > 95% | threads first admin reply `<= sla_due_at` (server) |
| Order-status share of support (falling) | `support_messages.topic in (payment, order)` share (server) |

Server-side metrics live in a `docs/metrics.sql` set of saved queries (create with
Module 6) and the Admin Home. No warehouse at MVP.

## Events

### Acquisition & onboarding
| Event | Params | Screen |
|---|---|---|
| `app_first_open` | `install_source` | 1 |
| `eligibility_check_started` | — | 2 |
| `eligibility_question_answered` | `question_id`, `step` | 2 |
| `eligibility_check_completed` | `relationship_category`, `nulla_osta_status` | 2 |
| `eligibility_whatsapp_tapped` | — | 2 |
| `signup_started` | `method` (google/email/phone) | 3 |
| `signup_completed` | `method`, `from_eligibility` (bool) | 3 |
| `login_completed` | `method` | 3 |
| `device_evicted_notice_shown` | — | 3 |
| `disclaimer_accepted` | `version` | 4 |
| `applicant_added` | `relationship_category`, `index` | 6 |
| `onboarding_completed` | `applicant_count`, `duration_s` | 7 |

### Core usage
| Event | Params |
|---|---|
| `today_viewed` | `action_count`, `all_clear` (bool) |
| `today_action_tapped` | `kind`, `rank` |
| `case_viewed` | `access_level`, `readiness_bucket` (0-25/25-50/50-75/75-100) |
| `checklist_filter_used` | `filter` |
| `item_viewed` | `requirement_code`, `status`, `has_badge_source_review` |
| `item_status_changed` | `requirement_code`, `from`, `to`, `offline` (bool) |
| `item_conflict_shown` | `count` |
| `document_uploaded` | `mime`, `size_bucket`, `linked` (bool) |
| `source_link_opened` | `requirement_code` |
| `how_we_verify_viewed` | `from` (paywall/item/dashboard) |
| `notification_opened` | `tab`, `type`, `from_push` (bool) |
| `journey_viewed` | `current_stage` |

### Monetisation
| Event | Params |
|---|---|
| `paywall_viewed` | `trigger` (locked_items/feature/dashboard), `locked_count` |
| `checkout_started` | `service`, `persons`, `doc_count` |
| `checkout_waiver_checked` | `service` |
| `order_placed` | `service`, `value_minor`, `currency`, `credit_applied` (bool) |
| `payment_proof_uploaded` | `service`, `retry` (bool) |
| `order_confirmation_viewed` | `service`, `due_in_hours` |
| `premium_unlocked_viewed` | `persons` (the unlock moment) |
| `refund_requested` | `service`, `reason_code` |
| `renewal_requested` | — |

GA4 `purchase` is **not** sent from the client at order placement — the money isn't
received until admin approval. Revenue reporting is server-side only.

### Support, referral, account
| Event | Params |
|---|---|
| `support_opened` | `from` (dashboard/order/confirmation/item) |
| `support_message_sent` | `topic`, `has_attachment` |
| `support_topic_blocked` | `topic` (free user hit a paid-only topic) |
| `referral_viewed` | — |
| `referral_shared` | `channel` |
| `referral_claimed` | — |
| `withdrawal_requested` | `amount_bucket` |
| `language_changed` | `to` |
| `perf_tier_downgraded` | `from`, `to`, `reason` |
| `account_delete_requested` | — |

## Implementation

- One `AnalyticsService` in Flutter with a typed method per event (no free-form
  `logEvent(String)` calls in feature code). Generated from this file is a nice-to-have;
  a unit test asserting every method's param keys match this table is required.
- DebugView in dev/staging; production property separate per Firebase project
  (ENVIRONMENTS.md), so test traffic never pollutes production numbers.
