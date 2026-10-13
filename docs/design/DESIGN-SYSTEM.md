# Design System — "Glass-lite"

**Status:** v1, for review. Tokens: `tokens.json`. Visual reference: `mockups.html` (open in a browser).
**Binding with:** Screens v2 (Copy Rules, Motion budget, Empty States).

---

## 1. Principles

1. **Trust over flash.** The product sells verified information at €99.99. Glass is
   the *frame*; content sits on near-opaque surfaces and is always readable.
2. **Never look official.** No Italian flag tricolour, no crests, no embassy blue/gold
   pairing, no "gov"-style seals. PRD §18 — the app must not present itself as an
   authority. The palette is Mediterranean (lagoon + terracotta), not national.
3. **Status is never colour alone.** Every status has colour + icon + label (WCAG 1.4.1).
4. **Low-end Android first.** Pakistan's install base skews to 3–4 GB RAM devices.
   Blur is a budget, not a default (§4).

---

## 2. Tokens (summary — `tokens.json` is the source)

### Colour

| Role | Light | Dark | Use |
|---|---|---|---|
| `bg.base` | `#EEF2F7` | `#070D1F` | scaffold behind the mesh |
| `bg.mesh` | lagoon/indigo/terracotta blobs @ 35% | same @ 45% | the thing glass blurs |
| `surface.glass` | `rgba(255,255,255,0.62)` | `rgba(18,26,52,0.58)` | blurred chrome: app bar, nav, sheets, hero |
| `surface.tint` | `rgba(255,255,255,0.82)` | `rgba(20,29,58,0.86)` | **unblurred** list cards — the glass *look* without the GPU cost |
| `surface.solid` | `#FFFFFF` | `#111A33` | low-tier fallback, text-heavy screens (legal, item detail body) |
| `stroke.glass` | `rgba(255,255,255,0.7)` | `rgba(255,255,255,0.10)` | 1px top-left highlight border |
| `text.primary` | `#0B1530` | `#F2F5FB` | ≥ 7:1 on surface.tint |
| `text.secondary` | `#475069` | `#A9B3CC` | ≥ 4.5:1 on surface.tint |
| `brand.lagoon` | `#0E7C86` | `#3CC4CC` | primary actions, progress |
| `brand.terracotta` | `#C8552D` | `#F08A5D` | premium accent, paywall, unlock moment |
| `brand.indigo` | `#2B3A8C` | `#8C9BFF` | links, info |

**Status (5) — colour + icon + label, always together**

| Status | Colour (L / D) | Icon |
|---|---|---|
| Not Started | `#6B7489` / `#8D96AD` | ○ circle-outline |
| In Progress | `#2563EB` / `#6EA0FF` | ◐ half-circle |
| Ready | `#15803D` / `#4ADE80` | ✓ check-circle |
| Issue Found | `#B42318` / `#FF7A70` | ! alert-triangle |
| Not Applicable | `#9AA1B2` @ 60% / `#5D6680` | — dash, row greyed + reason line |

**Badges (orthogonal, may stack)**

| Badge | Style |
|---|---|
| Blocking | red outline pill, lock icon, "Blocking submission" |
| Needs Review | amber fill `#B45309`/`#FBBF24`, sync icon |
| Source updated — under review | violet fill `#6D28D9`/`#C4B5FD`, eye icon |

### Type

Inter (Latin) · Noto Nastaliq Urdu (when Urdu ships — needs +20% line-height, tested separately).
Tabular figures (`tnum`) for every price, %, countdown and reference ID.

| Token | Size / line / weight |
|---|---|
| display | 28 / 34 / 700 |
| title | 20 / 26 / 650 |
| headline | 17 / 24 / 600 |
| body | 15 / 22 / 400 |
| label | 13 / 18 / 550 |
| caption | 12 / 16 / 500 |

Respect OS font scale up to 1.3×; layouts must not clip at 1.3×.

### Space, radius, elevation

- Space: 4-pt scale `4 8 12 16 20 24 32 40`. Screen gutter 16.
- Radius: `sm 10 · md 16 · lg 22 · xl 28 · pill 999`. Cards `lg`, sheets `xl` top only.
- Elevation is **not** drop shadow: glass uses a 1px inner highlight + a soft
  `0 8 24 rgba(7,13,31,0.12)` ambient shadow on hero/sheet only.

---

## 3. Glass rules — where blur is allowed

| Surface | Treatment | Why |
|---|---|---|
| App bar (pinned) | **blur 20** + `surface.glass` | content scrolls under it — the one place blur reads as glass |
| Bottom nav | **blur 20** + `surface.glass` | same |
| Modal / bottom sheet | **blur 24** + `surface.glass` | single layer, short-lived |
| Dashboard hero (combined readiness) | **blur 16**, one per screen | static, not inside a scroll list |
| Paywall / unlock moment | **blur 24** | the premium moment — worth the cost |
| List cards (case cards, checklist rows, orders, notifications) | **no blur** → `surface.tint` + highlight stroke | lists are where `BackdropFilter` janks |
| Long text (legal, item detail body, support thread) | `surface.solid` | reading comfort + contrast |

**Hard limits**
- Max **2 live `BackdropFilter`s on screen** at once (bar + nav, or sheet + bar).
- Never a `BackdropFilter` inside a `ListView` item.
- Never stack glass on glass — a sheet over a glass card uses `surface.solid` inside.
- Text on glass ≥ 4.5:1 measured against the *worst* point of the mesh behind it.

---

## 4. Performance tiers (Flutter)

Decided once at startup, stored in a Riverpod provider, overridable in Settings
("Reduce visual effects").

| Tier | Trigger | Behaviour |
|---|---|---|
| `full` | RAM ≥ 4 GB and Android ≥ 10, no battery saver | Rules in §3 |
| `lite` | RAM < 4 GB, or Android 8–9, or frame-drop detector trips | Blur removed everywhere; glass surfaces become `surface.tint`; mesh kept as a static image |
| `solid` | OS "reduce motion"/"high contrast", battery saver, or user setting | `surface.solid` everywhere, no mesh, no motion beyond fades |

- RAM via `device_info_plus` (`totalMemory` / `physicalRamSize` — **verify field name against the pinned plugin version**).
- Frame-drop detector: `SchedulerBinding.addTimingsCallback`; > 10% frames over 16 ms
  across 120 frames on the Dashboard → downgrade to `lite` for the session and log
  `perf_tier_downgraded` (ANALYTICS.md).
- Implementation: one `GlassSurface` widget reads the tier. No screen calls
  `BackdropFilter` directly — a lint (`custom_lint` rule or grep in CI) enforces it.
- Mesh background is a pre-rendered WebP per theme, not a live gradient shader.

Gate 4 (TESTING.md) Flutter frame-timing check runs on a **low-end reference device**
(e.g. a 3 GB Android 10 phone), not the developer's phone.

---

## 5. Core components

| Component | Notes |
|---|---|
| `GlassSurface` | tier-aware; props: `blur`, `radius`, `strong` |
| `CaseCard` | Screen 8. Name · relationship · stage · ring progress · "4 blocking". Copy pattern locked: `Spouse · Nulla Osta received · 68% ready · 4 items blocking submission` |
| `ReadinessRing` / `ReadinessBar` | animated, never snaps (Screens motion budget) |
| `StatusChip` | the 5 statuses, icon + label |
| `BadgePill` | the 3 badges |
| `VerifiedStamp` | "Verified 12 days ago" — **prominent**, top of item detail, not footer (PRD §13). Turns amber > `app_config.verification.stale_days` |
| `ChecklistRow` | status chip, title, badges, translation/apostille icons; N/A variant greyed + reason line |
| `LockedRows` | free tier: blurred placeholder rows + "+18 more documents" + CTA. Blur here is a **static pre-rendered** image, not BackdropFilter |
| `SlaDeadline` | "Verified by Fri 2:00 PM" + working-hours line; always both (PRD §14a rule 2) |
| `PriceBreakdown` | 4 categories, never merged (PRD §14) |
| `OrderTimeline` | vertical stepper |
| `SyncPill` | "Saved — will sync" (never "Offline") |
| `EmptyState` | copy from Screens v2 table, verbatim |
| `NotificationBell` | unread badge, on every top-level screen |
| `UnlockMoment` | full-screen terracotta glass + haptic after payment approval |

---

## 6. Motion

Shared-axis transitions (300 ms, `emphasizedDecelerate`), readiness bar tween 600 ms,
status micro-animation 200 ms, haptic `lightImpact` on status change, `mediumImpact`
on submit/approval. `solid` tier and OS reduce-motion → fades only.

---

## 7. Accessibility checklist (per screen)

- [ ] Contrast measured on glass against worst mesh point (≥ 4.5:1 body, ≥ 3:1 large)
- [ ] Tap targets ≥ 48 dp
- [ ] Status = colour + icon + label
- [ ] Semantics labels on rings/bars ("68 percent ready, 4 items blocking")
- [ ] 1.3× font scale renders without clipping
- [ ] TalkBack pass on the primary flow

---

## 8. Admin CMS (Next.js)

Glass does **not** apply. Operators read dense tables for hours — use `surface.solid`,
same colour tokens, same status chips, Tailwind with the tokens exported as CSS
variables. SLA breaches use the Issue Found red.
