# Module 08 — Support thread, admin inbox, canned responses

## 1. Purpose
PRD §10 / §14a, Screens 25 + 35: one support thread per user, an SLA the UI states as a **computed working-hours deadline**, tier-based topics (free: pre-sales/app/account;
paid: all), jpeg/png attachments, and an admin inbox sorted by SLA with canned responses. Support can explain and link to a published requirement; it cannot give a verdict (PRD §10 scope boundary).

## 2. Scope
In: migration `0013`; user + admin APIs; `lib/working-hours.ts`; Cron `support_retention`; erasure/export integration; `support_reply` notification. Out: order-linked threads (needs Module 6 — `order_id` has no FK yet), push-to-admin, assignment rules, the Flutter/CMS UIs.

## 3. Contract
See `docs/API-CONTRACT.md` (Support) and `docs/api/openapi.yaml`. New error code `SUPPORT_TOPIC_NOT_ALLOWED` (403). No breaking changes. Free→paid is evaluated per request from the applicant's premium state (`currentTier`).

## 4. Data — `0013_support` (expand-only; rollback = DROP, data loss is acceptable pre-launch)
`support_threads`, `support_messages`, `support_attachments`, `canned_responses`; config `support` + `sla`. CHECKs encode the invariants: deadline exists iff `awaiting_support`; user messages carry no admin id; closed ⇔ `closed_at`.
Retention declared in the migration: closed threads 24 months after last message.

## 5. Decisions
1. **Working hours are config.** `addWorkingHours(from, hours, windows)` walks the configured window (fixed UTC offset — correct for Pakistan; revisit before reuse elsewhere). Granularity is the **minute**. A malformed window degrades to plain elapsed hours rather than failing a message.
2. **Deadline rules.** First user message → `now + SLA(tier)`. Follow-ups while awaiting support do **not** move it. An admin reply stops the clock (`awaiting_user`, deadline NULL). The next user message restarts it. A message to a closed thread reopens it.
3. **Tier topics** come from config (`support.topics_free`) and are checked in the service before any storage call.
4. **Attachments** use the documents pattern: Worker-mediated HMAC capability URLs, no S3 credentials, jpeg/png only; on send the object is verified (`head` size + magic bytes) **before** the thread lock is taken; a mismatch deletes the object (`UPLOAD_REJECTED`).
5. **Rate limit**: `support.messages_per_hour` counted in SQL inside the send transaction (after the thread row lock, so concurrent sends can't both slip under).
6. **Scope boundary by tooling.** Canned responses render **real context** (requirement title/deep link/source/verified-days-ago/working-hours text); a missing value is a 422 naming the placeholder — never a half-filled message. Free-text replies need a topic and are screened with the same verdict-phrase list as CMS copy. Canned bodies are validated on save (English required, known placeholders, no verdict language).
7. **Audit** every admin mutation in the same transaction; the reply is audited **without its body** (PII). The user notification (`notify()`) runs after commit; its failure is logged, not thrown — the reply must not be lost to a notification problem.
8. **Admin inbox ordering**: awaiting_support by `(sla_due_at, id)`; other states by `(last_message_at DESC, id DESC)`. Both keyset, each with a matching index. (Gate 4 caught `NULLS LAST` defeating the index; removed — a thread always has a message.)
9. **No idempotency key** on send (the draft contract had `clientRequestId`; removed). Double-tap protection is the client's job; a duplicate is a harmless extra message. Revisit if support reports duplicates.

## 8. Test results
**305 tests green** (`support.test.ts` 28, `working-hours.test.ts`). Round-trip: 13 migrations, identical schema.

| Gate | Result |
|---|---|
| 1 Static | typecheck clean; wrangler bundles 3 envs (1068 KiB / 207 KiB gz) |
| 2/3 | thread view; send (tier SLA, working-hours SLA, follow-up keeps deadline, reply stops clock, restart); topic enforcement + config change; rate limit; attachments (reserve/PUT/verify/magic-byte reject/view); mark-read; admin inbox order + keyset; assign/close/reopen; free-text screening; canned CRUD + rendering from real context + missing-context 422; audit rows without bodies; retention; erasure + export include support; **cross-user 404** on thread, messages and attachments |
| 4 | at **15,000 threads / 150,000 messages**: all 11 support queries pass `pnpm gate4` (SLA inbox 0.18 ms, user message page 0.09 ms, summary counts 1.0 ms — the slowest; all index-driven) |
| 5 | every user read filters `user_id` in SQL; attachment keys never exposed; capability URLs opaque-404; admin scope `support_manage` on every route; audit bodies omitted; **open:** the R2 adapter has not run against a real bucket; rate limiting at the edge is separate |

### Found by this module's tests / gate
- Gate 4: `ORDER BY last_message_at DESC NULLS LAST` can't use a default-ordered DESC index → seq scan; fixed in the service and gate.
- Test isolation: tests edit `app_config` rows (`sla`, `support`); `resetDb` leaves config alone, so the suite now restores them in `beforeEach`.

## 9. Not verified here
R2 adapter with a real bucket; FCM delivery of `support_reply`; Worker CPU p99; real working-hours copy (owner).
