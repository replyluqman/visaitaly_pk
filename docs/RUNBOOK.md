# Runbook

Symptom → check → fix. Every entry starts with the `requestId` from the user's
error screen if there is one: `wrangler tail --env production --search <requestId>`.

## Everyone is signed out / every call returns 401 `UNAUTHENTICATED`

1. `wrangler tail` — look for JWK fetch or KV errors in the verifier.
2. Check Google's key endpoint reachability and Firebase status.
3. Check KV: `wrangler kv key get --binding PUBLIC_JWK_CACHE_KV firebase-public-jwks --env production`.
4. Check `FIREBASE_PROJECT_ID` matches the project the app signs in to.
Mitigation lives in the client (refresh once before signing out). If the client
lacks it, this incident logs out every user.

## Every `/v1` call returns 500, `/health` is fine

Database binding or connectivity.
1. `wrangler deploy --dry-run --env production` — both `HYPERDRIVE` and
   `PUBLIC_JWK_CACHE_KV` listed?
2. Neon console: project awake, not over compute quota (free tier: compute hours
   run out first, PRD §4).
3. `wrangler hyperdrive get <id>` — origin still correct after a Neon password reset?

## Error 1027 / requests rejected

Free-tier 100k requests/day exceeded (resets 00:00 UTC). Upgrade to Workers Paid.

## Requests fail with "exceeded CPU" (Error 1102)

10 ms CPU ceiling. `wrangler tail` shows which route. Short term: Workers Paid.
Then profile: payload size, JWT verify, query result parsing.

## A user says "logged out on my phone"

Expected after a third device signs in. Check:
```sql
SELECT device_id, platform, model, status, last_login_at, evicted_at
  FROM devices WHERE user_id = (SELECT id FROM users WHERE firebase_uid = '<uid>')
 ORDER BY last_login_at DESC;
```
`evicted` = device limit; `signed_out` = remote sign-out from Account screen.

## User stuck on the Disclaimer Gate

```sql
SELECT doc_type, locale, version, is_current, published_at FROM legal_versions WHERE is_current;
```
No current `disclaimer` row = nobody can pass (content gap, not a bug). Publish via CMS.

## User cannot sign in after deleting and re-creating their account

Fixed by migration 0004 (the `users_email_lower_uq` index no longer exists). If login
still fails, look elsewhere; do not hand-edit rows without recording it.

## Premium shows wrong

`/v1/me` computes from `applicants.premium_status`, `access_until`, `grace_until`
against `now()`.
```sql
SELECT id, premium_status, access_until, grace_until, status FROM applicants
 WHERE user_id = (SELECT id FROM users WHERE firebase_uid = '<uid>');
```
Any manual change here is an admin action and must be audit-logged (PRD §16) —
until the admin module exists, record it in the incident note.

## Bad migration in production

See `DEPLOYMENT.md` → Rollback. Stop further deploys first.

## Incident note (write one for every user-visible incident)

```
Date / duration:
Impact (users, endpoints):
Detection (how we found out):
Root cause:
Fix:
Follow-ups (each one a ticket):
```
