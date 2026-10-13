# Module 03b — Documents (R2) & Today

## 1. Purpose
Screen 14 (My Documents), inline upload on Screen 11, and Screen 9 (Today / Next Action). PRD §5, §8, §15, §19; SECURITY.md "Documents (R2)".

## 2. Scope
In: `documents`, `next_actions`, `app_config.uploads` / `today` (migration `0007`); two-step signed upload; signed view URLs;
delete that removes the R2 object; real `documentCount` / `documents` on checklist items; Cron-materialised Today.
Out: expiry *reminders* (Module 5 reads `documents.expiry_date`), OCR / AI verification (post-MVP), "waiting on us" actions (need orders — 6/7).

## 3. Contract
| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/v1/documents/upload-url` `{mime,sizeBytes,sha256,applicantId,checklistItemId?,expiryDate?}` | `UploadUrlResponse` | 402, 403 read-only, 404, 413 `UPLOAD_TOO_LARGE` / `UPLOAD_QUOTA_EXCEEDED`, 422 |
| POST | `/v1/documents/:id/complete` | `Document` (idempotent) | 404, 422 `UPLOAD_REJECTED` |
| GET | `/v1/documents?applicantId&cursor&limit` | `DocumentList` (+ quota) | 404, 422 |
| GET | `/v1/documents/:id` | `Document` with short-lived `viewUrl` | 404 |
| DELETE | `/v1/documents/:id` | 204 | 403 read-only, 404 |
| PUT | `/v1/documents/:id/content?exp&sig` | 204 — the upload (capability URL, no session) | 404 (any signature problem), 422 `UPLOAD_REJECTED` (length/type ≠ reserved) |
| GET | `/v1/documents/:id/content?exp&sig` | the bytes, streamed (capability URL) | 404 |
| GET | `/v1/today` | `TodayResponse` | 402 `PREMIUM_REQUIRED` (no premium/grace applicant) |

New codes (not session-terminal): `UPLOAD_TOO_LARGE` 413, `UPLOAD_QUOTA_EXCEEDED` 413, `UPLOAD_REJECTED` 422.
Contract changes vs `openapi.yaml` (planned → built): `TodayResponse.actions[]` is **structured, not prose** —
`{kind, reason, title (CMS requirement title | null), applicantId, itemId | null, dueDate | null, deepLink}`; the client formats the
sentence (the server holds no hard-coded English). `allClear` = `{nextStage}`. `ChecklistItem.documentCount` is now real;
`ChecklistItemDetail.documents` lists the item's documents (no `viewUrl`). Breaking for shipped clients: **none** (nothing shipped).

## 4. Data — `0007_documents_today` (expand-only; rollback = DROP)
`documents`: `user_id`, `applicant_id`, `applicant_requirement_id?`, `r2_key` (uuid-based, unguessable, generated server-side),
`mime`, `size_bytes`, `client_sha256` (client-asserted, not verified), `expiry_date`, `status pending|active|deleted`, timestamps.
**No filename stored** (PRD §19). `next_actions`: one row per applicant, overwritten by Cron. Config: `uploads
{max_file_bytes, max_bytes_per_user, upload_url_ttl_seconds, view_url_ttl_seconds, allowed_mimes}`, `today
{max_actions, expiry_window_days, batch_size}`. Retention: `pending` rows are purged by Cron after 2×URL TTL (object deleted
too); `deleted` rows kept 30 days for audit, then purged (Cron, Module 5 sweep list).

## 5. Decisions
1. **Worker-mediated, HMAC-signed, short-lived URLs — not R2 S3 presigned URLs.** The bucket is never public and *no S3
   credentials are ever issued*; the only path to an object is the `DOCS_BUCKET` binding held by the Worker. A URL is
   `…/content?exp=<epoch>&sig=<HMAC-SHA256(DOCUMENTS_SIGNING_KEY, "<METHOD>.<id>.<exp>")>`: it binds verb, document and expiry
   (a view URL cannot be replayed as an upload URL), and is verified in constant time. This keeps the whole upload/view path
   testable in CI against an in-memory `ObjectStore` (the production adapter is ~20 lines over the binding) and removes three
   secrets and an unverifiable third-party signing dependency. Cost: bytes flow through the Worker (R2→Worker is free; the
   10 ms CPU budget is respected because bodies are streamed, never buffered or hashed). *The R2 adapter itself is exercised only
   against a real bucket on first staging deploy — LAUNCH-CHECKLIST.* Rejected alternative: aws4fetch presigned URLs (direct to R2).
2. **Size and type are enforced at `complete`, not trusted from the client**: R2 `head` size must equal the declared size and the
   first bytes must match the declared type (JPEG / PNG / PDF magic bytes). A failing object is deleted and the row removed.
3. **Quota** = active + still-live pending bytes, from `app_config`; a pending upload reserves quota so the URL can't be farmed.
4. Writes follow the access rules: grace/expired → `APPLICANT_READ_ONLY`; linking to a checklist item beyond the free preview → 402.
   Reads are always allowed. Unauthorised access is 404 everywhere.
5. **Delete removes the R2 object first**, then marks the row; if R2 fails the call 500s and the row survives for a retry.
6. **Today is never computed on the request path** (PRD §15): a Cron-triggered, set-based `INSERT … SELECT` refreshes the stalest
   `batch_size` applicants per run; `GET /v1/today` only reads `next_actions`. Staleness is bounded by the cron cadence and
   exposed as `computedAt`. Premium-only (PRD §8): free users get 402 so the client shows the paywall.
7. Rank: expiring (document / Nulla Osta expiry inside `expiry_window_days`, soonest first) → blocking submission →
   to-do in the applicant's current stage (issue found first). An item appears once, at its best rank.

## 8. Test results
**149 tests green** (`documents.test.ts` 28, `today.test.ts` 11, +110 earlier). Migration round-trip: 7 migrations, identical schema.

| Gate | Result |
|---|---|
| 1 Static | typecheck clean (src + tests + shared); `wrangler deploy --dry-run` bundles dev/staging/production (920 KiB / 176 KiB gz) with the R2 binding and cron trigger declared per env |
| 2 Unit | every new code (`UPLOAD_TOO_LARGE`, `UPLOAD_QUOTA_EXCEEDED`, `UPLOAD_REJECTED`, `PREMIUM_REQUIRED`, `APPLICANT_READ_ONLY`, `CONFLICT`); magic numbers; signed-URL round trip / method / id / exp / tamper / malformed / wrong key; quota (active + live pending, expired pending released, per user, re-checked at complete); config-driven caps and mime list |
| 3 Integration | reserve→PUT→complete→view bytes with correct headers; idempotent complete; PUT refuses wrong length/type before reading, every signature failure is an opaque 404, replay after activation is 404; wrong magic / wrong size are rejected **and the object is discarded**; checklist linking (foreign item, N/A item, other applicant's item, free-tier locked item) and real `documentCount`; grace → reads ok, writes 403; keyset list + filters; delete removes R2 object then row, and an R2 failure leaves the row for retry; retention purge; **cross-user 404 on complete / get / delete / list / reserve-against-foreign-applicant**; Today: not computed on request, ranking, dedupe, caps, status ordering, batching/staleness, idempotency, premium-only (402 free/expired, grace readable), per-user isolation |
| 4 Query & load | 208k documents + 1.875M checklist rows: list 0.03 ms, applicant list 0.01, quota 0.02, by-id 0.02, item count 0.01, Today read 0.02. Cron `refresh next_actions`: **2.3–2.5 s for 15,000 applicants**, index-driven (planner fence on the lateral probes), so 75,000 applicants refresh in 5 runs of the `*/10` cron ≈ every 50 min. 32 queries total pass `pnpm gate4` |
| 5 Security | below |

### Security checklist
- [x] Every user query filters `user_id` in SQL; foreign applicant/item/document → 404; capability URLs are the only session-less path and fail as 404
- [x] Object keys are server-generated UUIDs (`u/<user>/<doc>`); no filename stored; client sha256 is recorded as client-asserted, not trusted
- [x] Type and size verified from storage at `complete` (magic bytes + `head`), never from the client; failures discard the object
- [x] URL binds verb + id + expiry, HMAC constant-time verify; TTLs from `app_config`; `Cache-Control: private, no-store`, `nosniff`, `inline`
- [x] Delete removes the R2 object first; retention declared in the migration and enforced by Cron
- [x] Quota + per-file cap server-enforced, serialised per user (`FOR UPDATE`), config-driven
- [x] Access rules enforced in the service (grace/expired read-only; free tier cannot link locked items)
- [x] No server-side English in Today; no PII in logs
- [ ] **Open:** rate limiting on `/v1/documents/upload-url` is an edge rule (not in code); the signing key must be set with `wrangler secret put` before the first deploy; first staging upload verifies the real R2 adapter
- [ ] **Open:** a compromised/leaked view URL is valid for `view_url_ttl_seconds` (default 5 min) — accepted, same as any bearer capability

### Known limitations
- Today lags by up to one cron cycle (~50 min); `computedAt` is returned. "Waiting on us" actions arrive with orders (6/7).
- Orphaned R2 objects whose rows were hard-purged are not reconciled; a bucket-vs-table sweep belongs with the privacy/erasure work (Module 10).
