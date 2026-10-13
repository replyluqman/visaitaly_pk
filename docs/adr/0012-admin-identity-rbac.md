# 0012 — Admin identity, RBAC and audit
Status: Accepted — follows `docs/ERD.md` §Module 10 and PRD §16; built early because the CMS (Module 4) cannot exist without it | Date: 2026-10

## Context
Every admin surface (CMS, queues, lookup) needs authentication, scope checks and an audit trail. PRD §16 defines `super_admin`
plus 12 independently assignable scopes and requires every admin action — including read-only case lookups — to be audit-logged.
ERD §Module 10 already decided: a **separate Firebase project** for admins and MFA.

## Decision
1. **Separate Firebase project** (`ADMIN_FIREBASE_PROJECT_ID`). A user token carries the user project as its audience, so it is
   rejected by the admin verifier — a leaked user token can never reach an admin route. `firebase-auth-cloudflare-workers`'
   `Auth.getOrInitialize` is a process-wide singleton that ignores the project id on later calls, so the admin verifier builds its
   own `BaseAuth` per project.
2. **Pre-registration by email, link on first login.** A `super_admin` creates the `admins` row (email, scopes); `firebase_uid` is
   NULL until the person first signs in with a *verified* email matching it. No self-signup path exists. The first super admin is
   created by hand: `scripts/create-super-admin.mjs`.
3. **MFA enforced by configuration**: `ADMIN_REQUIRE_MFA="true"` in staging/production (preflight blocks anything else); a token
   without `firebase.sign_in_second_factor` gets `ADMIN_MFA_REQUIRED`.
4. **Scopes:** write needs the screen's scope (or super); read needs the screen's scope, `read_only`, or super. Denial is 403
   `ADMIN_FORBIDDEN` — admin routes are not an id-enumeration surface; user-owned data still 404s (ADR 0006).
5. **Status is checked on every request** (one query returns admin + scopes): disabling an admin takes effect immediately;
   there is no admin session to expire. The last active super admin can't be disabled or demoted, nor can anyone disable themselves.
6. **Audit log** is written in the same transaction as the action it records, append-only (a trigger rejects UPDATE, and DELETE
   of anything younger than 12 months), `metadata` carries ids and changed field *names*, never PII values.

## Consequences
New codes `ADMIN_FORBIDDEN` (403), `ADMIN_MFA_REQUIRED` (403) — neither session-terminal for the *user* app; the CMS handles them.
Module 10 later adds data export/deletion, case lookup, legal manager on top of this foundation.
