# Module 04a — Admin foundation (identity, RBAC, audit)

## 1. Purpose
The CMS (Module 4b) and every later admin queue need authentication, scope checks and an audit trail (PRD §16, §18; Screens §30–32, §45).
Built before 4b because nothing admin-facing can ship without it. Decision record: `docs/adr/0012-admin-identity-rbac.md`.

## 2. Scope
In: migration `0008` (`admins`, `admin_permissions`, `audit_log`), `requireAdmin(scope, access)` / `requireSuper`, `/v1/admin/me|admins|audit-log`,
bootstrap script, audit helper used by every later admin mutation. Out: case lookup, data export/deletion, legal manager (Module 10);
the CMS web UI (separate app).

## 3. Contract
| Method | Path | Who | Success | Errors |
|---|---|---|---|---|
| GET | `/v1/admin/me` | any active admin | `{admin: AdminProfile}` | 401, 403 `ADMIN_FORBIDDEN` / `ADMIN_MFA_REQUIRED` |
| GET | `/v1/admin/admins?cursor&limit` | super | `{items[], nextCursor}` | 403, 422 |
| POST | `/v1/admin/admins` `{email, displayName?, isSuper?, scopes[]}` | super | 201 `AdminProfile` | 403, 409 duplicate email, 422 |
| PATCH | `/v1/admin/admins/:id` `{displayName?, status?, isSuper?, scopes?}` | super | `AdminProfile` | 403, 404, 409 lock-out guard, 422 |
| GET | `/v1/admin/audit-log?actorId&action&targetType&targetId&cursor&limit(≤100)` | any active admin | `{items[], nextCursor}` | 403, 422 |

New codes (not user-session-terminal): `ADMIN_FORBIDDEN` 403, `ADMIN_MFA_REQUIRED` 403. Breaking changes: none.
Bearer token = a Firebase ID token from the **admin** project.

## 4. Data — `0008_admin_foundation` (expand-only; rollback = DROP, warns to export the audit log first)
`admins` (nullable unique `firebase_uid`, unique `email`, `is_super`, `status`), `admin_permissions` PK `(admin_id, scope)` with the 12 PRD §16
scopes, `audit_log` (append-only; trigger refuses UPDATE and DELETE of rows < 12 months old). Indexes serve: login (`firebase_uid`), first-login
link (`email`), admin list (`created_at,id`), audit by target / actor / time / action. Retention declared in the migration header.

## 5. Decisions
See ADR 0012. Notable: (a) the library's `Auth.getOrInitialize` ignores the project id after the first call, so the admin verifier builds its own
`Auth` per project (`adminAuthFor`) — proven against real signed JWTs in `admin-token.test.ts`; (b) pre-registration + link-on-verified-email, no self-signup;
(c) MFA via config, enforced by `preflight` in staging/production; (d) status/scopes read from the DB every request, so revocation is immediate;
(e) the action and its audit row share a transaction.

## 8. Test results
**173 tests green** (`admin.test.ts` 18, `admin-token.test.ts` 5, +150). Round-trip: 8 migrations, identical schema.

| Gate | Result |
|---|---|
| 1 Static | typecheck clean; wrangler bundles all 3 envs with the admin vars; `preflight` checks MFA="true" and admin project ≠ user project |
| 2/3 | 401 no token; non-admin valid token → 403 and **no row created**; a *user* token never authenticates an admin route; MFA required/distinct code; disabled admin locked out next request; first-login linking by verified email only, once, impostor with same email refused; super-only routes 403 for scoped admins; create validation/duplicate/normalisation/dedupe; patch diff recorded in audit; revocation immediate; lock-out guards (no self-disable/demote, last super stays); keyset lists incl. **sub-millisecond exactness**; audit filters + cursor; append-only trigger; action+audit atomic (forced audit failure rolls the admin back); no PII in audit metadata |
| 3 (real tokens) | A token minted for the user project fails the admin verifier and vice versa; singleton quirk demonstrated; second-factor claim readable; expired/forged rejected |
| 4 | 500k audit rows: newest page 0.05 ms, by target 0.03, by actor 0.11, rare action 0.03 (after adding `audit_log_action_idx`; before it a rare action seq-scanned 500k rows in 20 ms), admin lookup 0.09 ms |
| 5 | Admin routes are scope-checked in the middleware, not per-handler discretion; token audience separation proven; no self-signup; status checked per request; MFA gate; secrets none; audit append-only. **Open:** rate limiting on `/v1/admin/*` (edge rule); admin Firebase project + MFA enrolment + first super admin are owner actions (LAUNCH-CHECKLIST) |

### Bug found by this module's tests (also affected Module 3b)
Keyset cursors rebuilt the timestamp from a JS `Date` (millisecond precision), so rows sharing a millisecond but differing in microseconds could be
**skipped or repeated across pages**. Fixed in `lib/cursor.ts` (timestamp travels as exact Postgres text) for admins, audit **and the Module 3b documents list**; regression tests added to both.
