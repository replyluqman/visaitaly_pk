# VisaItaly PK — Flutter app brief

Skeleton built (`MODULE-F1-SKELETON.md`): flavors, network, session, router guards, auth → legal → onboarding → dashboard.
Read before writing any Dart:

1. `docs/FLUTTER-ARCHITECTURE.md` — layout, layers, networking, routing (binding)
2. `docs/API-CONTRACT.md` — every endpoint, error code and client action
3. `docs/VisaItalyPK-Screens-v2.md` — the 29 user screens
4. Root `CLAUDE.md` — invariants that apply to both sides

## Non-negotiables

- Route on `GET /v1/me` (`legal`, `user.onboardingState`), never on local flags.
- Server decides access: show read-only UI from `applicant.access.canWrite`, and
  still handle `APPLICANT_READ_ONLY`.
- `UNAUTHENTICATED` → refresh token once, retry once, then sign out. Other terminal
  codes → sign out immediately. Single-flight the sign-out.
- Branch on `error.code`, never on `message`.
- Device id = UUIDv4 in `flutter_secure_storage`. Never a hardware id.
- Calendar dates are `YYYY-MM-DD` strings, never `DateTime`.
- No API secrets in the app. No PII in logs or analytics events.
- Enums decode with an `unknown` fallback.
- Every user-facing string goes through l10n ARB files (Urdu later, PRD §11a).
  Copy follows PRD §18 rules — no guarantees, no legal advice wording.

## Per feature, in this order

DTOs (freezed) + golden-JSON contract test → repository + unit tests (mocktail)
→ controller + unit tests → screens + widget tests for loading / error / empty /
read-only → integration flow against staging.

A feature is done when all of the above pass and its screen states match Screens-v2.

## Commands

```bash
flutter pub get                  # also runs gen-l10n (generated l10n + *.g.dart/*.freezed.dart are NOT committed)
dart run build_runner build
flutter analyze
flutter test
flutter test integration_test --flavor staging -t lib/main_staging.dart
```

If unsure about a package version or a Play/Android requirement, verify — do not guess.
