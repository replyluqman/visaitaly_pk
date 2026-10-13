# Module 03c — Eligibility Quick Check (public)

## 1. Purpose
Screen 2 / PRD §11: 4–6 questions, no account, returns an **orientation** summary and the top items this profile
typically needs. The only value delivered before sign-up and the primary conversion surface — and the highest
PRD §18 Risk 1 exposure, so the code owns **no wording**: every sentence is CMS content in a versioned row.

## 2. Scope
In: migration `0006`, `GET|POST /v1/public/eligibility-check`, shared applicability definition, copy rules in `preflight`.
Out: authoring UI (Module 4 CMS), per-IP rate limiting (edge rule, `LAUNCH-CHECKLIST.md`), pre-filling applicant 1 (client-side).

## 3. Contract
| Method | Path | Auth | Success | Errors |
|---|---|---|---|---|
| GET | `/v1/public/eligibility-check?locale` | none | `EligibilityQuestionSet {version, disclaimer, questions[]}` — `Cache-Control: public, max-age=3600` | 404 (nothing published) |
| POST | `/v1/public/eligibility-check` `{version, answers}` | none | `EligibilityResult {summary, typicalItems[≤N], lockedCount, disclaimer, whatsappUrl}` — `no-store` | 404, 422 |

No new error codes. `mapsTo` hints never leave the server. Breaking changes: none.

## 4. Data — `0006_eligibility_check`
`eligibility_check_versions(version, questions, summaries, disclaimer, whatsapp_url, is_current, published_at)`; unique
partial index = at most one current; CHECKs: ≤ 6 questions, current ⇒ published, `wa.me` links only. Expand-only; rollback = DROP.
Content only in `seed/seed_dev_eligibility.sql` (every string carries `[DEV PLACEHOLDER]`).

## 5. Decisions
1. **Stateless.** Nothing is stored — no answers, IP or identifier (PRD §19 minimisation; test asserts row counts unchanged).
2. **Same rules as the real case.** `requirementApplies()` is the one definition used by case generation and here, so the
   "typical items" are exactly what the user's checklist would contain. An unasked/unknown input (location, Nulla Osta
   status, DOB) never excludes an item.
3. `typicalItems` length and `lockedCount` use `app_config.checklist.free_preview_items` — the same "3 + N more" as the
   paywall preview, no second tunable.
4. A published version that cannot produce a summary (no category question / missing summary) is a content-setup bug →
   opaque 500 + log, never a made-up answer. `preflight` should catch it first.
5. **Copy guard:** `copy-rules.json` forbidden phrases ("you are eligible", "you qualify", "we advise", …) and the
   placeholder marker are checked by `pnpm preflight` against the current version. List to be extended by the lawyer review.
6. A stale `version` is a 422 with `details.version` — the client reloads the question set and re-asks.

## 8. Test results
**110 tests green** (`test/eligibility.test.ts`: 12). G1 typecheck clean. G2/G3: 404 before publish, no auth, mapping hints
hidden, cache headers, locale fallback, category/location change the items, `lockedCount`, nothing persisted, every 422
(stale version, unknown question, missing answer, bad option, bad shape, malformed JSON), misconfigured version → 500,
schema guards (one current, published, ≤ 6 questions, wa.me only), copy-rule file + dev seed. G4 at 1.9M rows: current-version
lookup 0.01 ms, typical items 0.04 ms (requirements is a tens-of-rows table). G5: public endpoint — input bounded
(≤ 6 answers, keys/values ≤ 64), no SQL concatenation, no PII, errors opaque; **rate limiting is an edge rule that must
exist before launch** (open, tracked). Migration round-trip: 6 migrations, identical schema.
