# Observability

**Constraint:** no new vendor, no new recurring cost at MVP (PRD §4, §10). Everything
below runs on Cloudflare, Firebase and GitHub, which are already in the stack.
Revisit (e.g. Sentry, Grafana) only when a measured gap appears.

## What we must be able to answer

| Question | Source |
|---|---|
| Is the API up? | Uptime workflow (`.github/workflows/uptime.yml`), every 15 min |
| Why did *this* user's request fail? | `requestId` in the error body → Workers Logs search |
| Are we inside the 10 ms CPU budget? | Workers dashboard CPU-time percentiles + `wrangler tail` |
| Is the app crashing? | Firebase Crashlytics |
| Are payments / support inside SLA? | Admin Home (Screen 31) — SLA breach is a product metric, not a log |
| Did the Cron jobs run? | `cron_run` log line + heartbeat row (below) |
| Funnel / conversion | Firebase Analytics (`docs/ANALYTICS.md`) |

## API — structured logs

Every log line is one JSON object (the error handler in `src/index.ts` already does this):

```json
{"level":"error","requestId":"…","path":"/v1/orders","method":"POST","route":"orders.create",
 "status":500,"durMs":38,"dbMs":21,"queries":3,"userId":"uuid","code":"INTERNAL","message":"…","stack":"…"}
```

Rules:
- **`requestId` on every line**, and returned to the client in every error body (already).
- `userId` (internal uuid) is allowed. **Never**: email, name, phone, document data,
  IBAN, tokens, request bodies (SECURITY.md — PII stays out of logs).
- Levels: `error` (bug / 5xx), `warn` (handled but suspicious: rate-limit hit, conflict
  spike, quota near), `info` (one access line per request — sampled if volume needs it).
- Add an access-log middleware in Module 3 that records `status`, `durMs`, and the
  per-request `queries` count (TESTING.md Gate 4 asserts on it in dev).

Storage: **Workers Logs** (`[observability] enabled = true` in `wrangler.toml`).
Free-plan volume/retention is limited — **verify current limits on the account**;
if they are too short for incident review, enable Logpush to the R2 bucket
(`visaitaly-logs`, 30-day lifecycle rule). Logpush availability by plan must be
verified before relying on it.

Live debugging: `npx wrangler tail --env production --format json`.

## Cron jobs — heartbeats

A Cron job that silently stops is the most likely invisible failure (reminders stop,
expiry stops, receipts stop). Each scheduled handler:

1. logs `{"level":"info","event":"cron_run","job":"reminders","durMs":…,"rows":…}`
2. upserts `app_config['cron_heartbeat'].<job> = now()`

`preflight` and the Admin Home warn when any heartbeat is older than 2× its schedule.

## Flutter

| Tool | Use |
|---|---|
| **Crashlytics** | fatal + non-fatal; non-fatal for every `INTERNAL` API error with the `requestId` as a custom key, so an app crash links to the server log line |
| **Performance Monitoring** | app start, screen render, HTTP traces (auto). Watch the Dashboard trace on low-end devices (DESIGN-SYSTEM §4) |
| Analytics | `docs/ANALYTICS.md` |

Crashlytics and Performance collection are gated by the `crash_reports` consent
(ERD `consents`; GDPR). Default **off** for users who decline.

Custom keys: `app_version`, `perf_tier`, `locale`, `onboarding_state`. No PII.

## Alerts (MVP)

| Signal | Mechanism | Who |
|---|---|---|
| `/health` down | Uptime workflow failure → GitHub email | on-call (you) |
| Error-rate spike | Cloudflare Notifications for Workers, if available on the plan — **verify**; otherwise a daily Cron that counts `error` lines is not possible without log query access, so check the dashboard daily | on-call |
| Crash-free users < 99% | Crashlytics velocity alerts (built in, free) | mobile |
| Payment queue past SLA | Admin Home red highlight + daily email digest from Cron (Module 6) | `payment_approve` admins |
| Cron heartbeat stale | Admin Home + preflight warning | on-call |
| Neon compute near limit | Neon console usage email | owner |

## Incident basics

1. Acknowledge in the team channel; note start time.
2. `wrangler tail` + Workers Logs by `requestId`.
3. Bad deploy → `wrangler rollback --env production`. Bad data → forward-fix migration.
4. Write a short post-incident note in `docs/runbooks/incidents/YYYY-MM-DD.md`:
   what happened, user impact, fix, the check we're adding so it can't recur.

## SLO-style targets (starting values; tune after two weeks of real traffic)

| Signal | Target | Source |
|---|---|---|
| 5xx rate | < 0.5 % of requests per hour | Workers dashboard |
| `/v1/me` CPU p99 | < 7 ms (headroom under the 10 ms ceiling) | dashboard / `wrangler tail` |
| `/v1/me` latency p95 | < 300 ms from Pakistan | access log |
| 401 `UNAUTHENTICATED` share | flat — a spike means a verifier/JWK problem | access log |
| Neon compute hours | < 70 % of the monthly allowance | Neon console |
| KV writes/day | < 500 (cap 1,000 on free) | dashboard |

## Required before launch (gaps today)

- `X-Request-Id` response header on **every** response (today only in error bodies) — set it in the requestId middleware.
- One structured access-log line per request, using the route **template** (`/v1/applicants/:id`), never the raw path.
- Never log: tokens, `Authorization`, email, names, DOB, document contents, FCM tokens. No stray `console.log`.
