# Roadmap — Pakistan → Italy MVP

**Assumes one full-time developer.** PRD §25 says 6–8 weeks + 1–1.5 for v3.1; with
three codebases (API, Flutter, CMS) and the test gates in TESTING.md, that is
optimistic for one person. The estimate below is the honest one. Each module ships
API + Flutter screens + CMS screens together, so it can be demoed end-to-end.

## Phase 0 — Foundations ✅ (this branch)

ERD · OpenAPI · design system · CI/CD · environments · observability · analytics
plan · GDPR design · content templates · launch checklist.

## Phase 1 — Close Modules 1–2 (≈ 1 week)

- `resolveEntitlement()` real query (STATE.md top item)
- Test harness: vitest + real Postgres; Gate 2/3 for Modules 1–2 incl. cross-user 404
- Rate limiting (Cloudflare rate-limit binding or WAF rule — verify plan availability)
- Flutter skeleton: flavors, Riverpod, go_router guards, Dio + terminal-code interceptor,
  `GlassSurface` + tokens, perf tier, Screens 1–7
- CMS skeleton: Next.js on Pages, admin Firebase auth, Screen 30

## Phase 2 — Core value (≈ 3–4 weeks)

| Module | API | Flutter | CMS | Est. |
|---|---|---|---|---|
| 4 Checklist engine + documents + Today | `0004`, generateCase, R2 signed URLs, next_actions Cron, hash sweep Cron | 8, 9, 10, 11, 12, 14, 15, 2 | 39, 40 | 2–2.5 w |
| 5 Notifications | `0005`, Cron reminders, FCM fan-out, retention Cron | 13, bell, 29 prefs | — | 1 w |

## Phase 3 — Money (≈ 3 weeks) — blocked on payable-currency decision

| Module | API | Flutter | CMS | Est. |
|---|---|---|---|---|
| 6 Orders & payments | `0006`, quote/order, proof upload, approve tx, receipts Cron | 16, 20, 21, 22, 23, 24 | 31 (partial), 33, 43 | 1.5 w |
| 7 Services + premium lifecycle | `0007`, translation/appointment, shipments, expiry Cron, renewals | 17, 18, 19 | 37, 38, 42 | 1.5 w |

## Phase 4 — Trust & retention (≈ 2–3 weeks)

| Module | Est. |
|---|---|
| 8 Support thread + inbox + canned responses (25 · 35) | 1 w |
| 9 Refunds (26 · 34) | 0.5 w |
| 10 Referral + withdrawals (27, 28 · 41) | 1 w |

## Phase 5 — Admin, privacy, hardening (≈ 2 weeks)

- 11 RBAC + audit + lookup + legal manager + GDPR export/delete (30–32, 36, 44, 45; 29)
- Motion/polish budget (Screens v2, ~2 days)
- Gate 4 at volume, Gate 5 security pass, DR drill, preflight clean

## Phase 6 — Launch (≈ 1–2 weeks, overlaps)

Play internal → closed testing (20–50 real families) → staged rollout.
Lawyer sign-off and verified content are the usual critical path, not code.

**Total: ≈ 12–15 weeks solo.** Two developers (one Flutter, one API+CMS) → ≈ 8–9 weeks.

## Post-MVP (PRD §20) — not before launch

iOS · Urdu · payment gateway · live courier tracking · WhatsApp reminders ·
more visa categories · more countries. Expansion needs a `program` dimension
(origin × destination × visa type) on relationships, requirements, stages and
pricing — additive expand-migrations plus relaxing a few CHECK lists, not a rewrite.
**No expansion work starts before the Pakistan → Italy MVP has paying users.**
