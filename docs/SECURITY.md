# Security

This app holds passports, ID cards, marriage and birth certificates for
Pakistani families. A leak is not an inconvenience — it is identity-document
exposure for real people. Treat every gate here as non-optional.

---

## Standing rules

**Authorisation is a service concern, not a route concern.** Every service
function that touches a user-owned row takes the caller's `userId` and filters
on it in the SQL `WHERE` clause. Never fetch-then-check in application code —
that pattern is one forgotten `if` away from a leak.

**Unauthorised access returns 404, never 403.** A 403 confirms the resource
exists, which lets an attacker enumerate ids. Same shape, same timing, for "does
not exist" and "not yours".

**Access level is enforced server-side only.** `grace_read_only` and `expired`
must be blocked in the service. The Flutter app hides the button as a UX
courtesy; that is not enforcement.

**Client input is never trusted for derived fields.** `relationship_category`,
`onboarding_state`, `access_level`, prices, and entitlement are all computed
server-side. If a client can send it, assume a client will forge it.

**Secrets live in `wrangler secret` only.** Never in `wrangler.toml`, never in
a `.env` that is committed, never in the Flutter binary. An Android APK is
trivially decompiled — the app ships with no API secret at all, only the
Firebase config, which is designed to be public.

**Errors never leak internals.** No SQL text, no stack traces, no library
messages to the client. `AppError` code plus a safe message. Log the detail
server-side with the request id.

**PII stays out of logs.** No document contents, no passport numbers, no full
names in Worker logs. Log user ids, not identities. Per PRD §19 no IP is stored
on `legal_acceptances` — do not reintroduce it anywhere else either.

---

## Per-module checklist

Work this list for every module before sign-off. Record findings in the module
doc, including "none found".

### Authorisation
- [ ] Every read filters by `userId` in SQL
- [ ] Every write filters by `userId` in SQL
- [ ] Cross-user access returns 404 (tested in Gate 3)
- [ ] Access-level check present on every write path
- [ ] Admin/CMS endpoints check the required permission scope, not just "is admin"

### Input
- [ ] Every route body, query and param parsed through a zod schema
- [ ] Every string field has a max length — unbounded strings are a DoS vector
- [ ] Uploads validated on content type and size, and on magic bytes, not on
      the filename extension
- [ ] All SQL goes through Drizzle or parameterised queries; zero string
      concatenation into SQL

### Output
- [ ] Response contains only fields the client needs — no internal columns, no
      other users' data, no admin notes on user-facing endpoints
- [ ] Error responses carry no internals

### Rate limiting
- [ ] Auth endpoints rate-limited per IP and per user
- [ ] Write endpoints rate-limited per user
- [ ] Upload endpoints rate-limited per user, with a storage quota

### Documents (R2)
- [ ] Object keys are unguessable (UUID), never sequential or name-derived
- [ ] Access is via short-lived signed URLs; the bucket is never public
- [ ] Ownership is verified before a signed URL is issued
- [ ] Deletion removes the R2 object, not only the DB row

### Data lifecycle
- [ ] New PII columns are listed in the GDPR delete path
- [ ] Retention policy defined for anything append-only
      (see `docs/SCALE.md`)

---

## Standing threats, with the mitigation

| Threat | Mitigation |
|---|---|
| User B reads user A's documents | `userId` in every WHERE; cross-user 404 test |
| Id enumeration | UUIDs, 404 not 403 |
| Forged entitlement — free user claiming premium | Entitlement resolved server-side from `applicants` |
| Stolen device keeps a live session | 2-device rule, remote sign-out, `DEVICE_EVICTED` terminal code |
| Replayed / tampered Firebase token | Verified per request via `firebase-auth-cloudflare-workers` |
| Credential stuffing on login | Rate limit + Firebase's own protections |
| Malicious upload | Magic-byte check, size cap, no execution, served from R2 not the app origin |
| Scraping the requirement catalogue | Auth required on content endpoints; rate limit |
| SQL injection | Drizzle / parameterised only |
| Secret in the APK | No API secret ships to the client, by design |

---

## Before first production deploy

- [ ] `wrangler.toml` has zero `REPLACE_ME`
- [ ] All secrets set via `wrangler secret`, none in the repo
- [ ] DB role used by the API has least privilege; CMS uses a separate role
- [ ] The `0.1-draft` disclaimer text is replaced with real legal copy
- [ ] Neon backups / PITR confirmed enabled
- [ ] Rate limiting live at the Cloudflare edge
- [ ] A written GDPR delete procedure exists and has been executed once on a
      test account, end to end, including R2 objects
