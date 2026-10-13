# Launch checklist — owner actions (non-code)

Things only the business owner can do. Engineering can't finish without them;
several have long lead times, so **start the ⏱ items now**, in parallel with code.

Legend: ⏱ long lead time (weeks) · 🔒 blocks a module · 🚀 blocks public launch

## A. Accounts & infrastructure (blocks first deploy)

- [ ] 🔒 Domain `visaitaly.pk` (or final domain) → Cloudflare DNS. *Needed for `api.` / `admin.` / CORS.*
- [ ] 🔒 Cloudflare account (Workers Paid $5/mo recommended from day 1 — removes the 10 ms CPU risk, PRD §4)
- [ ] 🔒 **First staging upload** (Module 3b): set `DOCUMENTS_SIGNING_KEY`, then reserve → PUT → complete → view one real PDF and one JPEG from a phone; confirm the object is in the bucket under `u/<user>/<doc>`, the bucket is private, and delete removes it. The R2 adapter (`lib/storage.ts`) has only run against an in-memory fake until then.
- [ ] 🔒 Cloudflare edge rate-limit rules: `/v1/auth/*`, `/v1/public/*`, `/v1/documents/upload-url` (per IP) — none of these are limited in code.
- [ ] 🔒 Create per env (ENVIRONMENTS.md): Hyperdrive ×3, KV ×3, R2 buckets (docs ×3, backups, logs)
- [ ] 🔒 Neon project; branches `dev`, `staging`; region co-located with Workers (PRD §4 constraint 1). Paid plan before launch for PITR window
- [ ] 🔒 Firebase projects: user ×3 (dev/staging/prod) + admin ×3. Enable MFA on admin prod. App Check (Play Integrity) on prod
- [ ] 🔒 GitHub: Environments `staging` + `production` (required reviewer on production), secrets/vars per ENVIRONMENTS.md
- [ ] Replace the 9 `REPLACE_ME` values in `apps/api/wrangler.toml`
- [ ] ⏱ 🚀 Google Play Console developer account (identity verification can take days–weeks)
- [ ] Team password manager with every credential + `BACKUP_PASSPHRASE`

## B. Legal & compliance (blocks public launch)

- [ ] ⏱ 🚀 Lawyer engaged. Scope (PRD §18): ToS, privacy policy, disclaimer, refund +
      EU 14-day withdrawal waiver, liability, jurisdiction, courier liability, and
      **all user-facing copy** — Eligibility Quick Check first, then canned responses
      (`docs/content/CANNED-RESPONSES.md`)
- [ ] ⏱ Company registration status confirmed (SECP or sole proprietorship) — affects receipts, bank, Play Console
- [ ] 🚀 Privacy policy lists processors (DATA-PRIVACY.md §1); DPAs accepted with Cloudflare, Neon, Google
- [ ] 🚀 Retention periods confirmed: financial (7 y?), support (24 m?), audit (12 m + archive?) — lawyer + accountant
- [ ] 🚀 Breach runbook owner named (DATA-PRIVACY.md §5)
- [ ] Tax: does the service need NTN / sales-tax registration; what must a receipt show (ERD O2)

## C. Money (blocks Module 6)

- [ ] 🔒 **Decide payable currency** (ERD O1): PKR account in Pakistan with EUR→PKR rate snapshot, or EUR account. Affects checkout copy and order schema
- [ ] ⏱ 🔒 Company bank account; bank details for `app_config.bank_details`
- [ ] 🔒 If PKR: FX source and rule (daily rate from which bank? rounded how?)
- [ ] Rejection / refund / decline reason lists (CMS `reason_codes`)
- [ ] Confirm CMS defaults: referral €5, grace 30 d, renewal 1 month, SLA 12/24/48, working hours Mon–Sat 09–18 PKT (PRD §24)

## D. Operations

- [ ] ⏱ 🔒 Courier partner selected + contracted (liability for original documents, reference format, rates) — blocks translation orders
- [ ] ⏱ Translation provider(s) — qualified, with turnaround + per-document price list
- [ ] WhatsApp Business number (pre-auth escape hatch only)
- [ ] Support operator(s) named; working hours staffed
- [ ] Admin users list with scopes (PRD §16)

## E. Content (blocks Module 3 being useful)

- [ ] ⏱ 🔒 Verified requirements for spouse / child / parent from Pakistan
      (`docs/content/REQUIREMENTS-GUIDE.md`), four-eyes verified
- [ ] Source list (`sources`) with URLs to monitor
- [ ] Eligibility Quick Check: 4–6 questions + orientation copy per answer path (lawyer-reviewed)
- [ ] Translation document-type list with prices
- [ ] Final disclaimer / ToS / privacy text v1.0 (replaces dev `0.1-draft`; preflight blocks until done)
- [ ] Urdu: translation owner + target date (PRD §11a) — not launch-blocking

## F. Pre-launch engineering gates (tracked in STATE.md)

- [ ] All modules pass the 5 gates (TESTING.md)
- [ ] `pnpm preflight --env production` clean
- [ ] GDPR delete executed end-to-end on staging incl. R2
- [ ] Backup restored once into a fresh branch (DR drill)
- [ ] Load test at 30k-user seed volume (Gate 4)
- [ ] Low-end Android frame-timing check (DESIGN-SYSTEM §4)
