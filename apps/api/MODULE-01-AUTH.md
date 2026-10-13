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
- **`resolveEntitlement()` is a stub** returning empty. Shape is final; the query
  body lands with the applicants + orders modules. Do not read entitlement elsewhere.

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
pnpm --filter @visaitaly/api migrate:status   # ✓ 0001_auth_devices
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

## ⚠ Verify before first deploy

`firebase-auth-cloudflare-workers` publishes two `verifyIdToken` signatures across
versions — `(jwt, env)` and `(jwt, checkRevoked, env)`. Confirm against the installed copy:
```bash
grep -n "verifyIdToken" node_modules/firebase-auth-cloudflare-workers/dist/index.d.ts
```
If it takes three args, pass `false` for `checkRevoked` (we do not use Firebase
revocation). One-line fix, and `src/lib/firebase.ts` is the only place it appears.

## Client contract (Flutter, Module 2 input)

- Generate `device_id` once, persist in `flutter_secure_storage`, send on every request.
- Dio interceptor: on any code in `SESSION_TERMINAL_CODES`, clear local state,
  `FirebaseAuth.signOut()`, route to Login, show the message from `error.message`.
- Call `POST /v1/auth/session` after **every** sign-in, not just the first.
- Route on `me.user.onboardingState`, never on local flags.
