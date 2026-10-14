# 0013 — Firebase Auth now, with a planned exit to native Workers auth
Status: Accepted (amends 0003; renumbered from 0012 — that number was taken by the admin-identity ADR) | Date: 2026-10-14

## Context
PRD §4 claimed Firebase Auth is "unlimited users, never a cost line". Verified against
Google's published pricing (2026-10-14) that is wrong:

| MAU | Firebase Auth (email/Google) |
|---|---|
| ≤ 50,000 | free |
| 50k–100k | $0.0055 / MAU |
| 100k–1M | $0.0046 / MAU |
| 1M–10M | $0.0032 / MAU |

Worked totals (all users active monthly): 100k MAU ≈ $275/mo; 5M MAU ≈ $17,215/mo; at
20 % monthly-active, 5M users ≈ $4,415/mo. Phone/SMS in Pakistan is $0.22 per SMS —
rejected outright. Cost matters because many installs are "just checking".

Alternatives researched: Sign in with Google verified directly in the Worker (no
published per-user price, but "free" is not stated in Google's docs); email OTP via
Cloudflare Email Service (3,000/mo included on Workers Paid, then $0.35/1,000); own
email + password on Workers. Workers PBKDF2 is capped at 100,000 iterations (workerd
PR #7550 to raise it is open, unmerged) and its CPU cost against the 10 ms free ceiling
is **unmeasured**; scrypt/argon2 are not in Web Crypto (argon2 only via WASM).

## Decision
1. **Launch on Firebase Auth, email + password only.** No phone/SMS, no anonymous
   sign-in (anonymous users count as MAU), no custom claims, no Firebase social
   providers.
2. **Eligibility Quick Check (PRD §11) works without an account**, so installers who
   only look never become MAU. This is a hard requirement of the screen flow.
3. **Plan the exit now; execute when MAU nears the free limit.** Trigger: monitored
   Firebase MAU ≥ **35,000**. Until ~100k MAU the Firebase bill (≈$275/mo) is likely
   below the cost of building and running native auth.
4. **Migration-readiness work is part of the build** (list below), so the exit is a
   switch, not a rewrite.
5. When migrating to native auth: email + password with **lazy email verification**
   (verify by link only at payment or password reset), Cloudflare Turnstile on signup
   (free plan: unlimited challenges), per-account throttling, and a hashing approach
   chosen by a **CPU measurement spike** on a real Worker — not by assumption.

## Migration-readiness checklist (build with Modules 1–3)
- [ ] `users.id` (uuid) is the only identity used outside the auth module; `firebase_uid` never appears in any API response or other table.
- [ ] Migration (expand step): `users.auth_provider text NOT NULL DEFAULT 'firebase'` (`firebase|native`) and `users.email_verified boolean NOT NULL DEFAULT false`, with `.down.sql`.
- [ ] Token verification behind one interface returning `{ subject, email, emailVerified }`; middleware accepts multiple issuers (`iss`) so both token types can work during transition.
- [ ] Flutter: login behind an `AuthRepository` interface; no Firebase types leak into features.
- [ ] No Firebase custom claims, phone auth, anonymous auth, or social providers anywhere.
- [ ] Minimum-app-version check (server flag in `app_config` + client enforcement) so old clients can be forced to update at cutover.
- [ ] Firebase MAU watched monthly (Firebase/Identity Platform usage page); alert at 30,000.

## Migration paths (documented, not built)
1. **Just-in-time:** at login, verify password via Firebase REST `accounts:signInWithPassword`, store our own hash, set `auth_provider='native'`. Whether those REST sign-ins count toward MAU is **unverified**.
2. **Bulk + reset:** `firebase auth:export` users, send reset emails (≈$34 per 100k on Cloudflare Email).
Do **not** write a Firebase-scrypt verifier: it needs project-specific signer key, salt
separator and rounds, and both sources researched call homegrown verifiers fragile.
Social/phone identities are not portable (not used, by decision 1).

## Consequences
- Module 1–2 auth code stays; no docs rewrite now.
- Free until 50k MAU; the bill is visible and bounded in advance.
- A future migration is a real project (hashing, reset flow, throttling, app release).
- Password-reset and verification emails are sent by Firebase; their limits and cost
  are **not verified** — check before launch.

## Open
- Duplicate-email handling after Firebase account re-creation (`users_email_lower_uq`): recommendation is to drop the unique index until native auth exists; re-linking by email is only safe when `email_verified` is true. Decision pending.
