---
description: Security review of the current diff or a module against docs/SECURITY.md
argument-hint: [module or path]
---

Review $ARGUMENTS (default: uncommitted changes, `git diff`) for VisaItaly PK.

Check, with file:line evidence:
- Every user-owned query filters `user_id` in SQL WHERE; cross-user access → 404.
- Every input parsed by a shared zod schema; no client-supplied derived fields
  (`relationshipCategory`, access level, onboarding state).
- Access-level write gate (`free|premium` write; `grace_read_only|expired` don't) in the service.
- No secrets in code or `wrangler.toml`; no PII/tokens in logs.
- Error messages leak nothing internal (SQL, stack, library text).
- `FIREBASE_AUTH_EMULATOR_HOST` cannot take effect outside development.
- New tables: retention, FK indexes, cascade behaviour intended.
- R2 (when present): private bucket, signed URLs, content-type and size limits.
- Admin actions (when present): RBAC scope check + audit log row.

Report findings ranked by severity with a concrete fix each. Do not apply fixes
without confirmation.
