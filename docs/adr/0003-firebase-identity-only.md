# 0003 — Firebase for identity only; entitlement lives in Neon
Status: Accepted (PRD §5) | Date: 2026-09

## Context
Entitlement written in several systems causes "paid but not unlocked" desync.

## Decision
Firebase Auth supplies identity (uid, email). Tokens are verified in the Worker with
`firebase-auth-cloudflare-workers`, `verifyIdToken(jwt, false, env)`, JWKs cached in
KV. Premium, roles and onboarding live only in Neon and are returned by `/v1/me`.
No custom claims, ever.

## Consequences
- One-click approve is one Postgres transaction; no Firebase write to forget.
- The library is slow-moving (PRD §4 risk). Its arity changed across versions —
  `env` must be the 3rd argument. Pin it; re-verify on upgrade.
- Verifier failures (expired token **and** JWK fetch failure) both surface as
  `UNAUTHENTICATED`. The client refreshes once before signing out.

## Alternatives considered
Custom claims for premium (desync, token refresh lag), own auth (cost, security).
