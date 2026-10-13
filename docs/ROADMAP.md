# Roadmap — Pakistan → Italy MVP

Build order is PRD §25 and is not reordered without a scope decision. A module starts only after the previous one
passes all five gates (`TESTING.md`). Live detail for the current module: `../STATE.md`. Schema per module: `ERD.md`.

**Scope is Pakistan → Italy family reunification only.** Expansion (more countries, visa types, origins) waits until
the MVP has paying users; it needs a `program` dimension (origin × destination × visa type) on relationships,
requirements, stages and pricing — additive expand-migrations plus relaxing a few CHECK lists, not a rewrite.

## Modules

| # | Module | Backend | Gates | Flutter | CMS |
|---|---|---|---|---|---|
| 1 | Auth + device sessions | built (0001, 0004) | G1–G5 ✓ (CPU unmeasured) | not started | — |
| 2 | Legal gate + applicant profiles + onboarding | built (0002, 0003) | G1–G5 ✓ (CPU unmeasured) | not started | — |
| 3 | Checklist engine (5 statuses, badges, non-applicable with reason) | built (0005) | G1–G5 ✓ (CPU unmeasured) | 8–12, 2 | — |
| 3b | Documents (R2 uploads) + Today / next actions | built (0007) | G1–G5 ✓ (R2 adapter + CPU unmeasured) | 9, 14 | — |
| 4 | CMS / content + verification workflow + hash-change flags | built (0008 admin foundation, 0009) | G1–G5 ✓ (first real sweep on staging) | 15 | 39, 40 (API only) |
| 5 | Notifications — Cron generation + FCM + notification centre | | | 13 | — |
| 6 | Payments — manual proof, one-click approve, SLA, receipts, **refunds** | | | 16, 20–22, 23, 24, 26 | 31, 33, 34, 43 |
| 7 | Services (translation + courier, appointment) + premium lifecycle (expiry, renewal) | | | 17–19 | 37, 38, 42 |
| 8 | Support thread + admin inbox + canned responses | | | 25 | 35 |
| 9 | Referral + payouts | | | 27, 28 | 41 |
| 10 | Admin RBAC + audit log (**foundation built as 4a, migration 0008**) + case lookup + legal manager + data export/deletion | | | 29 | 30, 32, 36, 44, 45 |

Gates 1–5 have run for Modules 1–3 (`apps/api/MODULE-0N-*.md`). One cross-cutting gap remains for all of them:
**Worker CPU p99 (10 ms ceiling) is unmeasured** — it needs a deployed staging Worker.
Eligibility Quick Check (public, CMS-driven) shipped as Module 3c (migration 0006).

## Phases and honest estimates (one full-time developer)

PRD §25 says 6–8 weeks (+1–1.5 for v3.1); with three codebases and the test gates that is optimistic for one person.

| Phase | Work | Est. |
|---|---|---|
| 0 ✅ | Pre-code pack: ERD, OpenAPI, design system, CI/CD, environments, observability, analytics, privacy, content templates, launch checklist | done |
| 1 | Close Modules 1–2: P1 fixes (STATE.md), vitest + real-Postgres harness, Gates 2/3/5, rate limiting; Flutter skeleton (flavors, Riverpod, router guards, `GlassSurface`, Screens 1–7); CMS skeleton | ≈ 1–1.5 w |
| 2 | Modules 3, 3b, 4 (core value) | ≈ 3–4 w |
| 3 | Module 5, then 6 and 7 (money — **blocked on payable-currency decision, ERD O1**) | ≈ 4 w |
| 4 | Modules 8, 9 | ≈ 2 w |
| 5 | Module 10 + motion/polish + Gate 4 at volume + Gate 5 + DR drill | ≈ 2 w |
| 6 | Play internal → closed testing (20–50 real families) → staged rollout. Lawyer sign-off and verified content are usually the critical path, not code | 1–2 w, overlaps |

**Total ≈ 12–15 weeks solo; two developers (Flutter + API/CMS) ≈ 8–9 weeks.**

## Before production launch (cross-cutting)

Owner actions live in `LAUNCH-CHECKLIST.md`. Engineering gates:
- All `REPLACE_ME` filled; `pnpm preflight --env production` green.
- Real legal text published via CMS, lawyer-reviewed; account deletion flow (Play requires it) — `DATA-PRIVACY.md`.
- `X-Request-Id` header, structured logs, alerting (`OBSERVABILITY.md`); rate limiting on auth endpoints.
- PRD §24 open items resolved (courier, CMS defaults, WhatsApp number, canned responses, Urdu owner, lawyer scope).
- Load test at 30k-user data volume (`SCALE.md`).

## Post-MVP (PRD §20)

iOS · Urdu · payment gateway · live courier tracking · WhatsApp reminders · document vault · OCR · family
collaboration · more visa categories/countries.
