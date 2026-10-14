# Module 1 — Auth + Device Sessions

Covers PRD §2 (account model, 2-device limit), §5 (Neon = single source of truth),
§19 (access control); Screens §1 Splash, §3 Login/Signup, §29 Account/Settings.

## Endpoints

| Method | Path | Guard | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness. No DB touch. |
| POST | `/v1/auth/session` | Firebase token | Login. Upsert account, register device, apply 2-device rule. Idempotent. |
| GET | `/v1/me` | token + device | Entitlement + onboarding state. Called every launch. |
| GET | `/v1/devices` | token + device | Active sessions for the Account screen. |
| DELETE | `/v1/devices/:deviceId` | token + device | Remote sign-out. |

All authenticated requests send `Authorization: Bearer <firebase-id-token>` **and**
`X-Device-Id: <uuid v4>`.

## Design decisions worth knowing

- **Eviction is app-level, not Firebase revocation.** `devices.status = 'evicted'`;
  the next request from that device gets `401 DEVICE_EVICTED`. Firebase Admin SDK
  does not run in Workers, and doing it over Identity Toolkit would put
  service-account JWT signing on the request path.
- **`signed_out` ≠ `evicted`.** Different user-facing message. Same lockout.
- **`device_id` is a client UUIDv4** in `flutter_secure_storage`. Never `ANDROID_ID`
  (resets on reinstall → silently burns a device slot) and never a hardware id.
- **Device limit lives in `app_config`**, not in code. PRD §6 zero-hardcoding.
- **JWT is verified exactly once per request.** It is the dominant CPU cost.
- **`last_seen_at` is written on `/v1/me` only**, not on every request.
- **Entitlement** is resolved inside `loadMeSnapshot()` (Module 2) — one SQL
  statement with user, devices, legal and applicant state. Do not read entitlement
  anywhere else. (Module 1 shipped a stub here; superseded.)

## Setup

```bash
pnpm install
# 1. Neon: create project in the SAME region as your Workers (PRD §4).
# 2. Cloudflare:
wrangler kv namespace create PUBLIC_JWK_CACHE_KV        # → paste id into wrangler.toml
wrangler hyperdrive create visaitaly-db --connection-string="<neon-direct-url>"
# 3. Fill FIREBASE_PROJECT_ID + both ids in wrangler.toml
cp .dev.vars.example .dev.vars                          # DATABASE_URL = direct Neon url
export DATABASE_URL="$(grep DATABASE_URL .dev.vars | cut -d'"' -f2)"
pnpm db:migrate
```

## Verify

**1. Migration applies and rolls back cleanly**
```bash
pnpm db:status   # ✓ 0001_auth_devices
pnpm db:rollback && pnpm db:migrate           # must succeed twice in a row
```
Expect `app_config`, `users`, `devices` present; `app_config.auth` = `{"max_active_devices": 2}`.

**2. Health**
```bash
wrangler dev
curl localhost:8787/health          # {"ok":true,...}
```

**3. Login creates the account** — get a real ID token from the Flutter app or the
Firebase Auth emulator, then:
```bash
D1=$(uuidgen | tr 'A-Z' 'a-z')
curl -i localhost:8787/v1/auth/session \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"deviceId\":\"$D1\",\"platform\":\"android\",\"appVersion\":\"0.1.0\"}"
```
Expect `201` first time (`session.isNewUser: true`), `200` on repeat.
`onboardingState` must be `disclaimer_pending`. `entitlement.hasAnyPremium` false.

**4. The 2-device rule (the actual acceptance test)**
Register `D1`, then `D2` → both active, `evictedDeviceIds: []`.
Register `D3` → response contains `evictedDeviceIds: ["<D1>"]`.
Then:
```bash
curl -i localhost:8787/v1/me -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $D1"
# 401  {"error":{"code":"DEVICE_EVICTED",...}}
curl -s localhost:8787/v1/me -H "Authorization: Bearer $TOKEN" -H "X-Device-Id: $D3"  # 200
```
Eviction must pick the **oldest by `last_login_at`** — re-open D1 before registering D3
and D2 must be the one evicted instead.

**5. Failure modes**
| Request | Expect |
|---|---|
| no `Authorization` | 401 `UNAUTHENTICATED` |
| expired token | 401 `UNAUTHENTICATED` |
| valid token, no `X-Device-Id` | 400 `DEVICE_HEADER_MISSING` |
| valid token, unregistered device id | 401 `DEVICE_UNKNOWN` |
| `deviceId: "not-a-uuid"` in body | 422 `VALIDATION_FAILED` with `details.deviceId` |
| `DELETE /v1/devices/<D2>` then `/v1/me` as D2 | 204, then 401 `DEVICE_SIGNED_OUT` |

**6. CPU budget** — check `wrangler tail` or the Workers dashboard CPU-time p99 for
`/v1/me`. Target well under 10 ms. If JWT verify alone pushes past it, that is the
signal to take the $5/mo Workers Paid escape hatch (PRD §22 risk 8b) rather than
redesign anything.

## ✓ Verified: `verifyIdToken` arity

Installed v2.0.6 signature is `verifyIdToken(idToken, checkRevoked?, env?, clockSkewSeconds?)`.
`src/lib/firebase.ts` calls `verifyIdToken(jwt, false, env)`. Re-check on any upgrade:
```bash
grep -rn "verifyIdToken" node_modules/firebase-auth-cloudflare-workers/dist/*.d.ts
```

## Client contract (Flutter, Module 2 input)

- Generate `device_id` once, persist in `flutter_secure_storage`, send on every request.
- Dio interceptor: on any code in `SESSION_TERMINAL_CODES`, clear local state,
  `FirebaseAuth.signOut()`, route to Login, show the message from `error.message`.
  Exception: on `UNAUTHENTICATED`, force-refresh the token and retry once first
  (`docs/FLUTTER-ARCHITECTURE.md`).
- Call `POST /v1/auth/session` after **every** sign-in, not just the first.
- Route on `me.user.onboardingState`, never on local flags.

## Test results

**Date:** Phase 1 gates · **DB:** Postgres 16, migrations 0001–0004

| Gate | Result |
|---|---|
| 1 Static | `pnpm typecheck` clean (src + tests) |
| 2 Unit | Covered through the real service path in `test/auth.test.ts`, `devices.test.ts`: every Module 1 `AppError` code (`UNAUTHENTICATED`, `DEVICE_HEADER_MISSING`, `DEVICE_UNKNOWN`, `DEVICE_EVICTED`, `DEVICE_SIGNED_OUT`, `USER_DELETED`, `VALIDATION_FAILED`, `NOT_FOUND`), config-driven device limit + missing-row fallback, no clobber of display name / onboarding state |
| 3 Integration | 25 tests vs real Postgres: 201/200 login, 401/400/422 shapes, 2-device eviction (LRU), reactivation, remote sign-out, cross-user device sign-out → 404 and victim unaffected, other user's `device_id` → `DEVICE_UNKNOWN`, `X-Request-Id` on every response |
| 4 Query & load | `pnpm gate4` at 30k users / 60k devices / 75k applicants: session lookup 0.03 ms, login upsert 0.10 ms, evict 0.05 ms, `/v1/me` snapshot 0.12 ms, device touch 0.14 ms, device list 0.07 ms. No Seq Scan over a >10k-row table. **Not measured:** Worker CPU (10 ms ceiling) — needs `wrangler dev`/staging; tracked in `STATE.md` |
| 5 Security | see below |

### Findings fixed during the gates
1. **`createDb` never called `client.connect()`** — `pg.Client` queues forever without it, so every `/v1` request would have hung in a deployed Worker. Only a real-DB test could find this. Fixed; `createDb` is now async.
2. **Login rewrote PII on a deleted account** (undid the GDPR wipe). Upsert now has `WHERE users.status = 'active'` and refuses with `USER_DELETED` before any write.
3. **Re-signup with the same email under a new Firebase uid returned 500** — `users_email_lower_uq` dropped (migration 0004), regression test added.
4. `X-Request-Id` response header added (was error-body only).

### Security checklist (docs/SECURITY.md)
- [x] Reads/writes filter by `userId` in SQL (devices: `WHERE user_id = …`)
- [x] Cross-user access → 404, tested
- [x] Every body/param parsed by zod; string fields bounded (appVersion ≤ 32, model ≤ 128, fcmToken ≤ 512)
- [x] No SQL concatenation (Drizzle `sql` tagged templates only)
- [x] Errors carry no internals (asserted); unknown errors → opaque 500 + server log
- [x] Emulator env var ignored outside development (`libraryEnv`) + preflight
- [x] No IP stored anywhere; no PII in logs (only `requestId`, path, method, message)
- [ ] **Rate limiting** — not in code. Enforced at the Cloudflare edge (WAF rate-limit rule on `/v1/auth/*`, per-IP); must be configured before launch (`LAUNCH-CHECKLIST.md`). Per-user write limits deferred.
- N/A: uploads/R2 (Module 3b)

## Addendum — ADR 0013 migration-readiness (migrations 0014, 0015)
- `users.auth_provider` (`firebase|native`, CHECK) and `users.email_verified`: expand-only, constant defaults (no backfill pass needed); `email_verified` is rewritten from the token at every login. Exposed as `user.emailVerified` on `/v1/me`.
- Minimum app version: `app_config['app'].min_app_version` (default `0.0.0`). `registerSession` checks it **before any write** → `426 APP_UPDATE_REQUIRED` (not session-terminal); `/v1/me` returns `app.minAppVersion` so a running build can block itself. The comparison fails **open** on unparsable versions (`lib/version.ts`, mirrored in the Flutter app).
- Tests: `test/auth.test.ts` (5 new), `test/version.test.ts`, `test/config-admin.test.ts` (the `app` key). Round-trip: 15 migrations, identical schema.
- Not built: per-request version enforcement; the second-issuer token-verifier interface (only needed at cutover).
