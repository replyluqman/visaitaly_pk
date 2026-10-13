# 0004 — App-level device sessions and eviction
Status: Accepted | Date: 2026-09

## Context
PRD §2: max 2 active devices per account; a third login silently drops the oldest.
Firebase revocation (`revokeRefreshTokens` + `checkRevoked=true`) would need a
network call per request — over the 10 ms CPU budget — and an admin SDK.

## Decision
Devices are rows in `devices` keyed by `(user_id, device_id)` where `device_id` is a
client-generated UUIDv4 in secure storage. `POST /v1/auth/session` upserts and evicts
beyond `app_config.auth.max_active_devices` by `last_login_at`, in one transaction.
`requireSession` checks the device row on every request in the same query that loads
the user.

## Consequences
- Revocation is instant and costs no extra round trip.
- An evicted device's Firebase token stays valid until expiry, but every API call
  returns `DEVICE_EVICTED`.
- Reinstall = new UUID = new slot (by design; ANDROID_ID would also reset and is a
  Play policy risk).
- `evicted` vs `signed_out` are distinct so the client can show the right message.

## Alternatives considered
Firebase revocation (CPU + latency), hardware ids (policy risk, resets anyway).
