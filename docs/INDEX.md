# Documentation index

Every doc has one job. If two docs disagree, the one higher in this table wins,
and the lower one is a bug to fix.

| Precedence | Doc | Answers | Binding? |
|---|---|---|---|
| 1 | `VisaItalyPK-PRD-v3_1.md` | What the product is. | Locked. Changes need an explicit scope decision. |
| 2 | `VisaItalyPK-Screens-v2.md` | What the user sees (45 screens). | Locked. |
| 3 | `adr/` | Why a decision was made. | Accepted ADRs are binding until superseded by a new ADR. |
| 4 | `../CLAUDE.md` | Engineering invariants and layout. | Binding. |
| 5 | `TESTING.md` · `SECURITY.md` · `SCALE.md` | Gates, security checklist, 30k-user rules. | Binding. |
| 6 | `API-CONTRACT.md` · `DATA-MODEL.md` | The HTTP surface and schema as built. | Descriptive — the code is the truth; these must be updated in the same PR. |
| 6b | `api/openapi.yaml` · `ERD.md` · `design/DESIGN-SYSTEM.md` | Planned API + schema for Modules 3–10; UI system. | Plan — build against it, update it when a module changes it. `@visaitaly/shared` wins on conflict. |
| 7 | everything else | How to run, deploy, operate. | Procedural. |

## By task

| I want to… | Read |
|---|---|
| Get the backend running locally | `../README.md` → `ENVIRONMENTS.md` |
| Understand the system | `ARCHITECTURE.md` → `adr/` |
| Call the API from Flutter | `API-CONTRACT.md` → `FLUTTER-ARCHITECTURE.md` |
| Change the schema | `DATA-MODEL.md` → `SCALE.md` §4 → `/migration` command |
| Start a new module | `MODULE-TEMPLATE.md` → `/new-module` command → `TESTING.md` |
| Know if a module is done | `TESTING.md` "Definition of done" → `/gate-check` |
| Ship to staging / production | `DEPLOYMENT.md` → `ENVIRONMENTS.md` (CI does it) |
| Design a screen / use the glass UI | `design/DESIGN-SYSTEM.md` · `design/mockups.html` · `design/tokens.json` |
| Know what the schema will look like | `ERD.md` |
| Add analytics events | `ANALYTICS.md` |
| Author requirement content / canned replies | `content/` |
| What the owner must do (accounts, legal, bank, courier) | `LAUNCH-CHECKLIST.md` |
| Something is broken in production | `RUNBOOK.md` → `OBSERVABILITY.md` |
| Handle user data / consent / export / deletion | `DATA-PRIVACY.md` |
| Know what is next | `ROADMAP.md` · `../STATE.md` |
| Decode a term | `GLOSSARY.md` |

## Per-module records

`apps/api/MODULE-0N-*.md` — one per module: design, deviations, verify steps,
gate results. Written from `MODULE-TEMPLATE.md`.

## Rules for docs

- A PR that changes behaviour updates the doc that describes it, in the same PR.
- No status in `README.md` (it goes stale). Status lives in `STATE.md` and `ROADMAP.md`.
- A decision that took discussion gets an ADR, not a paragraph buried in a module doc.
- Prefer an automated check (`preflight`, CI) over a checklist line. A checklist line is
  what gets skipped at 2 a.m.
