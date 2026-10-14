# Module F2 — The app's screens (everything the backend supports today)

## 1. Scope
Built against `docs/VisaItalyPK-Screens-v2.md` (locked) and `docs/design/DESIGN-SYSTEM.md` (glass-lite).

| # | Screen | State |
|---|---|---|
| 1 | Splash | F1 |
| 2 | Eligibility Quick Check (pre-auth) | **built** — first open only; no token / device id sent |
| 3–7 | Login, Disclaimer Gate, Applicant Count, Applicant Profile, Stage Select | F1 |
| 8 | Family Dashboard | **built** — case cards in the locked copy pattern, combined-readiness hero, quick actions, bell |
| 9 | Today | **built** — sentences composed on the client from `kind/reason/dueDate`; locked / all-clear / not-computed states |
| 10 | Applicant Case View | **built** — readiness, personalization line, Nulla Osta card, server-side filters, client search, locked rows, greyed N/A rows with reason |
| 11 | Checklist Item Detail | **built** — Verified stamp on top, status selector, documents inline (upload / view / delete), source + "Verify with official source" footer, needs-review acknowledge |
| 12 | Journey Timeline | **built** |
| 13 | Notification Center | **built** — 3 tabs, unread counts, mark read on open, mark all, deep links (whitelisted) |
| 14 | My Documents | **built** — per-applicant filter, quota from the server, unlinked upload |
| 15 | How We Verify | **built** — live stats from the public endpoint, recent updates |
| 16 | Paywall | **preview sheet only** — no price, no purchase button (see §4) |
| 17–24, 26–28 | Translation, Appointment, Checkout, Proof, Order screens, Refund, Referral, Withdrawal | **not built** — backend Modules 6, 7, 9 do not exist (blocked on owner decision O1) |
| 25 | Support Thread | **built** — topics from the server by tier, SLA only beside working hours, image attachments, disclaimer footer |
| 29 | Account / Settings | **built** — push prefs, consents, devices, legal versions, data export, deletion with re-auth, sign out, "Reduce visual effects" |

Navigation: bottom bar (Home · Today · Documents · Account) with the bell on every top-level screen; everything else pushes over it.

## 2. Design system (`lib/core/design`)
- `tokens.dart` (colours for both themes, space, radius, motion, type scale; variable **Inter** bundled, OFL licence included).
- `perf_tier.dart` — `full / lite / solid`, decided once from RAM, Android API, reduce-motion and high-contrast (unknown facts degrade to `lite`, never `full`); a frame-drop monitor can only lower it; Settings can force `solid`.
- `GlassSurface` is the **only** place a `BackdropFilter` exists (a test greps the codebase). Blur appears only on the full tier, never in list items, never when `strong`.
- `components.dart` — StatusChip (icon + label + colour), BadgePill, VerifiedStamp (amber beyond the server's `stale_days`), ReadinessBar/Ring (tweened, with TalkBack text), EmptyState.
- Automated checks: WCAG contrast of text and status colours on the card surface in both themes; no overflow at 1.3× font scale; one blur per surface rule.

## 3. Backend changes this module needed (additive)
`verification.stale_days` config + `staleAfterDays` on item detail (migration 0016); `applicantId` on item detail. 330 API tests green; round-trip identical (16 migrations).

## 4. Decisions and gaps
1. **Paywall**: until checkout exists the "locked" tap opens an honest sheet (what Premium covers, How We Verify, a pre-sales question). It never shows a price or purchase action.
2. **Search** filters the rows already loaded (the API has no text search); filters are server-side.
3. **Deep links** (notifications, Today) are followed only if they match a whitelist of app routes — a server string can never navigate to an arbitrary URL.
4. **Capability URLs** (document / attachment PUT and GET) are sent with no session token and no device id.
5. **File picking** goes through `FilePickerGateway`; a 64 MB memory guard (not a policy — real limits come back as 413 messages shown verbatim).
6. **No offline queue / "Saved — will sync" yet** (DECIDE in docs/FLUTTER-ARCHITECTURE.md). Writes are online-only; `baseVersion` / `clientMutationAt` are unused.
7. **Not built**: first-launch consent prompt (consents are editable in Account), FCM token registration / push, Urdu + RTL (gated by PRD §11a), app icon / splash artwork, haptics on approval/unlock moment (no payments yet), analytics events.
8. Static copy (How We Verify points, support disclaimer, paywall text) is **user-facing copy that needs the lawyer review**; it is all in `app_en.arb`.

## 5. Test results
**179 Flutter tests green** (`flutter analyze` clean; clean-checkout verified). Contract tests decode REAL server output (51 fixtures captured from the API's handlers by `apps/api/test/mobile-fixtures*.test.ts`). Widget tests drive the real app against a stateful fake of the API: case view (filters hit the server, pagination cursor, locked rows, N/A reasons), item detail (status write, read-only, N/A, premium-locked, ack, upload / reject / too-large / delete), Today, Documents, Notifications (deep-link whitelist), How We Verify, Support (tier topics, SLA + hours, attachment order), Account (consents, prefs, devices, export, delete + re-auth), Quick Check (stateless, stale version, skip).

## 6. Not verified here
Everything on a real device: no Android build, no emulator, no screenshot review of the visual design, no frame-timing run on a low-end phone (Gate 4 for Flutter), no TalkBack pass, no real Firebase / FCM / R2. The design checks above are token-level and widget-level, not a visual sign-off.
