# Requirement content — authoring guide

The checklist is only as good as this data. It is **content**, owned by whoever holds
the `verification_manage` scope, and it never ships in a migration (CLAUDE.md).

**Nothing in this repo is a real requirement.** The template row is prefixed
`EXAMPLE_ONLY_` on purpose; `preflight` will fail if any requirement code starting
with `EXAMPLE_ONLY_` is published (added with Module 3).

## Workflow

1. Collect from **authoritative sources only** (PRD §13): Embassy/Consulate of Italy
   in Pakistan, Italian government (Prefettura / Sportello Unico, Ministry of Foreign
   Affairs), the official visa-service provider. Never blogs, agents, social media.
2. Fill `requirements.template.csv`, one row per requirement. Every row needs a
   `source_url` and a `last_verified_at`.
3. A **second person** verifies each row against the source (four-eyes) and puts
   their email in `verified_by_email`.
4. Import into **staging** via the seed script (Module 3 builds
   `seed/import-requirements.mjs`), review in the app as each of: spouse in Pakistan,
   child under 18, child over 18, parent — check what is shown *and* what is shown
   as not applicable.
5. Publish in production through the CMS (Screen 39), which records verifier +
   timestamp. From then on, edits go through the CMS only.

## Column rules

| Column | Rule |
|---|---|
| `code` | `snake_case`, stable forever; never reuse a retired code |
| `stage` | one of `eligibility nulla_osta documents translation appointment application processing decision` |
| `*_en` | plain English, ≤ 2 sentences each. Follow Copy Rules (Screens v2): "Spouse applications typically require…", never "you must / you are eligible" |
| `applies_*` | true/false per category. False everywhere = row is pointless |
| `applies_locations` | blank = all; else `pakistan` / `italy` / `other`, `;`-separated |
| `min_age_years` / `max_age_years` | only when the rule depends on age (e.g. minor vs adult child) |
| `requires_nulla_osta_status` | blank = any; else `not_started;in_process;received` subset |
| `na_reason_en` | **required** — shown to users for whom it doesn't apply: "Required for Parent category — not applicable to your case." |
| `blocks_submission` | true only if the application cannot be submitted without it |
| `validity_days` | where the source states a validity (Nulla Osta, police certificate…) |
| `source_authority` | `embassy` / `government` / `service_provider` |
| `last_verified_at` | the date someone actually opened the source and checked |

## Coverage target before launch

- Every stage has ≥ 1 requirement.
- Every category (spouse / child / parent) produces a sensible full case.
- 100% source-linked, 100% with a verification record (PRD §21 quality metrics).
- Eligibility Quick Check outputs reviewed by the lawyer first (PRD §18).
