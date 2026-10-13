# Module 05 — Notifications

## 1. Purpose
PRD §14 / Screens §13: one persistent inbox (Reminders · Updates · Activity), a bell badge that is a single indexed count, Cron-generated reminders and
requirement-update notices, and FCM push as a *delivery channel only* (Neon is the record; a missed push loses nothing).

## 2. Scope
In: migration `0010`; inbox API; preferences; `notify()` helper (the Activity-tab entry point for Modules 6–9); Cron: requirement-update dispatch, Nulla Osta + document
reminders, push fan-out, read-row retention; the **single consolidated cron** (`src/jobs.ts`). Out: appointment/waiting-list reminders (Module 7), Activity emitters (6–9),
per-user locale (Settings), the Flutter inbox UI.

## 3. Contract (session-authenticated)
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/notifications?tab&cursor&limit(≤50)` | one tab, newest first, keyset `(created_at,id)` |
| GET | `/v1/notifications/unread-count` | `{total, byTab}` — one grouped indexed count |
| POST | `/v1/notifications/:id/read` | 204, idempotent, keeps the first read time; 404 for someone else's |
| POST | `/v1/notifications/read-all` `{tab?}` | 204; body optional |
| GET/PUT | `/v1/notification-preferences` | `{push:{reminder,update,activity}}`; in-app cannot be disabled (DB CHECK) |

`Notification {id, tab, type, title, body, deepLink, applicantId, createdAt, readAt}`; **`deepLink` is mandatory** on every row (schema-enforced, PRD §14 rule 3).
No new error codes. Breaking changes: none.

## 4. Data — `0010_notifications` (expand-only; rollback = DROP)
`notification_templates` (CMS/seed content — **no copy in the migration**), `notifications` (unique `(user_id, dedupe_key)`; inbox, unread, push-queue, retention indexes),
`notification_preferences` (PK `(user_id, tab, channel)`), `notification_dispatch` (which requirement versions were announced). Config: `notifications`, `reminders`;
`verification.recheck_after_hours`, `today.min_age_minutes` added with `||` so admin-set values survive. Retention: **read** rows after 90 days (batched), unread kept.

## 5. Decisions
1. **Wording is data.** Titles/bodies come from `notification_templates` (`{title} {changeSummary} {days} {date}`), rendered in SQL with bound values; an unsupplied
   placeholder is removed, never shown as raw braces. Types the code can emit are listed in `src/lib/notification-types.json`; `preflight` fails a deploy with a missing English
   template, a `[DEV PLACEHOLDER]` template, or a forbidden (verdict) phrase. Render locale is `en` until the user-language setting exists.
2. **Updates** (PRD §14): each not-yet-dispatched requirement version → one `update` notification per affected applicant (premium/grace, with an *applicable* item), change summary inline.
   Idempotent by dedupe key + a dispatch row written in the same transaction. A missing template **skips and retries** — a version is never marked dispatched and silently lost; a version
   unpublished before the Cron ran is not announced. Free/expired applicants get none (premium feature, PRD §8).
3. **Reminders** from case data, one per threshold crossed (`reminders.days_before` 30/7/1, then 0 = expired); the bucket is in the dedupe key so each fires once however often the Cron runs.
   Nulla Osta (status *received*) and active documents with an expiry date; linked documents deep-link to the checklist item, unlinked to `/documents`.
4. **Push**: FCM HTTP v1 via a service-account JWT (WebCrypto RS256), token cached per isolate. `push_max_per_run` (40) bounds sends per run because the Workers **free tier allows 50 subrequests
   per invocation** — a large publish drains over several ticks (inbox is complete immediately). A notification leaves the queue when delivered to ≥ 1 device, when push is off for its tab,
   or when no usable device exists; dead tokens are cleared; transient failures retry up to `push_max_attempts`. Without `FCM_SERVICE_ACCOUNT` push is skipped and nothing is marked sent.
5. **One cron.** Cloudflare caps cron triggers per account, so the former two (`*/10`, daily) are replaced by one every-5-minute trigger running every job in `runScheduledJobs`. Each job is
   self-limiting: the hash sweep only touches sources unchecked for `recheck_after_hours` (20), the Today refresh only rows older than `min_age_minutes` (30). Jobs are isolated — one failing is
   reported, the rest still run.
6. Event-triggered Activity notifications call `notify(tx, …)` with the **same transaction** as the write that caused them (PRD §14 rule 4); unknown type or missing template throws, so a deploy problem is loud.

## 8. Test results
**239 tests green** (`notifications.test.ts` 28, `fcm.test.ts` 5). Round-trip: 10 migrations, identical schema.

| Gate | Result |
|---|---|
| 1 Static | typecheck clean; wrangler bundles 3 envs (993 KiB / 192 KiB gz, cron `*/5`) |
| 2/3 | inbox (per-tab order, keyset incl. sub-ms exactness, validation, unread grouping, idempotent read, read-all, preferences + in-app CHECK, deep-link CHECK); `notify()` (render, dedupe, unknown type, missing template, bound values); Updates (audience: premium+grace only, applicable only; added vs changed; summary inline; idempotent; missing template retried; unpublished not announced); Reminders (thresholds 30→7→1→expired once each, premium only, status *received* only, docs linked/unlinked, deleted excluded, configurable); Push (all devices, deep link in data, prefs off, no device, dead token cleared, retry then give-up, per-run budget oldest-first, no sender ⇒ stays queued); retention; jobs isolation; FCM adapter vs fake fetch (assertion claims + RS256 signature verified, single token fetch, 401 refresh, response mapping, OAuth failure ⇒ retry); **cross-user 404** on mark-read |
| 4 | at **1M notifications**: inbox page 0.06 ms, badge 0.04, mark-read 0.16, read-all 0.03, push queue 0.01, retention select 0.01, dedupe probe 0.02, Nulla Osta scan 0.02, **document-expiry scan 36 ms** (Cron, inside the 50 ms budget but the closest to it). 54 queries pass `pnpm gate4` |
| 5 | notifications filtered by `user_id` in SQL everywhere; template values bound; push payload = title/body/deep link only (no names, no PII); FCM tokens never logged; dead tokens cleared; secret only in `wrangler secret`; **open:** the FCM adapter has never talked to Google (first staging send); push throughput on the free tier; rate limiting is an edge rule |

### Bugs found by this module's tests
- **Drizzle expands a JS array into a record `($1,$2)`, not a Postgres array** — broke `text[]` writes in the CMS (`appliesLocations`, `requiresNullaOstaStatus` — never exercised before), reminders and push bookkeeping. Fixed with `lib/sql.ts` `pgArray()`; CMS regression test added.
- Optional-body endpoints rejected an empty body as invalid JSON (`read-all`) — `optionalJsonBody`.
- Wrangler 3's bundler rejects JSON import attributes (`with {type:'json'}`) — plain JSON import used.
