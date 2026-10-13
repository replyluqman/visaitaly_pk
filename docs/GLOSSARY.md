# Glossary

| Term | Meaning |
|---|---|
| **Account / user** | One Firebase identity = one `users` row. Usually the sponsor in Italy or a family member managing cases. |
| **Applicant** | A person on a visa journey, under an account. One account manages several. Premium is per applicant. |
| **Sponsor** | The family member legally resident in Italy who applies for the Nulla Osta. |
| **Family Reunification Visa** | *Ricongiungimento familiare* — the only visa category in scope. |
| **Nulla Osta** | Clearance issued by the Italian Sportello Unico; prerequisite for the visa. Has an expiry (default validity 6 months, CMS-configurable — provisional). |
| **Relationship code / category** | Code = specific relation (e.g. son). Category = `spouse\|child\|parent`, derived server-side; the rule engine keys off it. |
| **Journey stage** | One of 8: eligibility, nulla_osta, documents, translation, appointment, application, processing, decision. |
| **Case** | The generated checklist for one applicant at a stage. `case_generated_at` marks it exists (Module 3). |
| **Checklist item / requirement** | A document or step required for an applicant, with one of 5 statuses + badges (PRD §12). |
| **Non-applicable** | A requirement that does not apply to this applicant — shown with a reason, never hidden. Derived, not stored. |
| **Onboarding state** | `disclaimer_pending → applicants_pending → stage_pending → complete`. Server-computed. |
| **Disclaimer Gate** | Screen 4 — blocking acceptance of current mandatory legal versions. |
| **Legal version** | A published `(doc_type, locale, version)` of disclaimer/terms/privacy. Bumping the version re-gates every user. |
| **Premium** | Paid access for one applicant, until visa granted (PRD §7). |
| **Grace period** | After a user self-confirms visa granted: read everything, write nothing (`grace_read_only`). Support stays writable. |
| **Access level** | `free\|premium\|grace_read_only\|expired` — what the client branches on per applicant. |
| **Entitlement** | The set of premium and grace applicant ids, resolved from Neon on every `/v1/me`. |
| **Eviction** | A login beyond the device limit marks the oldest device `evicted`; its next call gets `DEVICE_EVICTED`. |
| **Session-terminal code** | Error code that makes the client sign out (`SESSION_TERMINAL_CODES`). |
| **Gate (1–5)** | Test gates per module: static, unit, integration, query/load, security (`TESTING.md`). |
| **Expand → backfill → contract** | Three-migration pattern for any change to a live column (`SCALE.md`). |
| **Preflight** | `pnpm preflight` — automated deploy gate. |
| **Hyperdrive** | Cloudflare's Postgres connection pooler; mandatory between Workers and Neon. |
| **JWK** | Google's public signing keys for Firebase ID tokens; cached in KV. |
| **SLA** | Response-time promises for payments/support (PRD §14a), CMS-configurable. |
| **RBAC scope** | Admin permission, e.g. `payment_approve` (PRD §16). |
| **PKT** | Pakistan Standard Time, UTC+5. All stored timestamps are UTC. |
