---
name: Bug report
about: Something behaves differently from the PRD, the API contract, or the docs
labels: bug
---

**Do not attach user documents, passport images, tokens or personal data. Use user ids and request ids only.**

## What happened

## What you expected

Reference: PRD § / `docs/API-CONTRACT.md` endpoint

## Request id

Every error response carries `error.requestId`. Paste it here — it is how the server log line is found.

`requestId:`

## Reproduce

1.
2.

## Context

- Environment: local / staging / production
- App version / device (if from the app):
- Endpoint and status code:
- Error `code`:

## Severity

- [ ] Data exposed to the wrong user (treat as a security incident — do not file publicly)
- [ ] Money or entitlement wrong (paid but locked, or unlocked without payment)
- [ ] Core flow blocked
- [ ] Degraded / cosmetic
