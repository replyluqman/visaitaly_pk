# Architecture

## System context

```
                 ┌──────────────────────┐
  Flutter app ──►│ Firebase Auth        │  identity only (uid, email). No entitlement.
  (Android)      └──────────────────────┘
      │  Authorization: Bearer <Firebase ID token>
      │  X-Device-Id: <client UUIDv4>
      ▼
┌──────────────────────────────────────────────┐        ┌───────────────┐
│ Cloudflare Worker  (Hono)   apps/api         │──KV───►│ JWK cache     │ Google public keys only
│  secureHeaders → CORS → requestId → db       │        └───────────────┘
│  → requireAuth / requireSession → routes     │
│  → services (SQL + rules) → AppError         │──R2───► blobs (later modules)
└──────────────────────────────────────────────┘
      │ pg over TCP (one Client per request)
      ▼
  Hyperdrive (pooling) ──► Neon Postgres   ◄── single source of truth (PRD §5)

  Cron Worker (later) ──► Neon ──► FCM       expiry sweep, notifications, hash checks
  CMS (Next.js, Pages, later) ──► same Worker API with admin RBAC
```

## Ownership (PRD §5)

| System | Owns | Never |
|---|---|---|
| Neon | entitlement, users, applicants, content, orders, notifications, audit | — |
| Firebase Auth | uid ↔ sign-in | premium, roles, onboarding — no custom claims |
| KV | Google JWKs | anything else (1,000 writes/day on free tier) |
| R2 | uploaded blobs, referenced by key from Neon | the record of anything |
| FCM | delivery | the record — a missed push loses nothing |

## Request lifecycle

1. `secureHeaders`, CORS, `requestId` (UUID, returned in every error body).
2. `db` middleware creates one `pg.Client` on Hyperdrive; `close()` is handed to
   `ctx.waitUntil` so teardown is off the measured path.
3. `requireAuth` verifies the Firebase ID token (`verifyIdToken(jwt, false, env)`,
   JWKs from KV). `requireSession` additionally loads user + device in **one query**
   and maps device state to `DEVICE_UNKNOWN | DEVICE_EVICTED | DEVICE_SIGNED_OUT`,
   deleted user to `USER_DELETED`.
4. Route parses with the shared zod schema (`parseOrThrow`) and calls a service.
5. Service runs SQL (filtered by `userId` in WHERE), enforces business rules and
   access levels, throws `AppError` on failure.
6. `onError`: `AppError` → its status + `ApiErrorBody`; anything else → logged with
   requestId, returned as opaque 500 `INTERNAL`.

## Layering rules

| Layer | May | May not |
|---|---|---|
| `routes` | parse input, read `c.get('session')`, call one service, pick status | SQL, business rules |
| `services` | SQL, transactions, rules, authorisation, call other services | touch `Request`/`Response`, read headers |
| `lib` | pure helpers, config reader, errors | import from modules |
| `packages/shared` | types, zod schemas, error codes | import runtime-specific code |

Known exception: `reference.routes.ts` runs one SQL query inline. Move it to a
`reference.service.ts` when that module is next touched.

## Hard constraints that shape every design

- **10 ms CPU per request** (Workers free tier). JWT verify + JSON parse already use
  a share. Consequences: one round trip for `/v1/me` (`loadMeSnapshot`), no large
  payloads, moderate batching only, anything heavy goes to Cron. Escape hatch:
  Workers Paid ($5/mo) — cheaper than any redesign.
- **No global connection.** Every request opens one client through Hyperdrive.
  Never `pg.Pool` in a Worker.
- **Entitlement is computed against `now()`** on read, not trusted from
  `premium_status` alone — the Cron sweep may lag.
- **Server-derived state only**: `onboarding_state`, `relationship_category`,
  access level, readiness. The client renders; it never decides.

## Session model

- `X-Device-Id` is a client-generated UUIDv4 in `flutter_secure_storage`. Never a
  hardware id.
- `POST /v1/auth/session` after every sign-in: upsert user, upsert device, evict
  beyond `app_config.auth.max_active_devices` (default 2) by `last_login_at`, all in
  one transaction.
- Eviction is app-level (`devices.status`), not Firebase revocation — revocation
  would need a network call per request (`checkRevoked`), breaking the CPU budget.
- Terminal codes (`SESSION_TERMINAL_CODES`) wipe the client session. See
  `FLUTTER-ARCHITECTURE.md` for the one refresh-and-retry on `UNAUTHENTICATED`.

## Environments

development (local, `wrangler dev` + local Postgres) · staging (own Neon branch,
own Firebase project) · production. Details: `ENVIRONMENTS.md`, `DEPLOYMENT.md`.

## Where the reasoning lives

`adr/` — one file per decision. Read those before proposing a change here.
