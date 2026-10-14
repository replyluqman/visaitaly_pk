# Module F1 — Flutter skeleton (auth → legal → onboarding → dashboard)

## 1. Purpose
The base every feature depends on (docs/FLUTTER-ARCHITECTURE.md "Before writing the first screen"): flavors, one Dio with the specified interceptors, a session controller that owns the `/v1/me` snapshot, server-driven router guards — plus the first vertical slice: Screens 1, 3, 4, 5, 6, 7, 8.

## 2. Scope
In: `core/{config,network,auth,storage,session,l10n,ui}`, `app/{router,app,bootstrap}`, features `auth`, `legal`, `onboarding`, `applicants`, `home`; en l10n; Android flavors; CI job.
Out: Eligibility Quick Check (Screen 2, pre-auth), checklist/documents/Today/notifications/support/account UI (backend exists; each is its own F-module), Google Sign-In, FCM registration, Urdu/RTL (gated by PRD §11a), offline cache (**DECIDE in Module 3** client work), app icons/theme polish.

## 3. How the invariants are met
| Rule | Where |
|---|---|
| Route on `/v1/me`, never local flags | `computeRedirect` is a pure function of `SessionState`; 12 unit tests |
| UNAUTHENTICATED → refresh once, retry once, then sign out | `ErrorInterceptor`; tests prove 2 requests, forced-refresh token, one sign-out |
| Terminal codes → sign out, no retry, single-flight | `ErrorInterceptor` + `SessionController.terminate`; burst test signs out once |
| Branch on `error.code` | `ApiError`/`errorText`; unknown code → INTERNAL |
| Retries: idempotent only, ≤ 2, backoff, never 4xx | `RetryInterceptor`; POST /applicants is deliberately NOT retried (duplicate applicant) |
| Device id = UUIDv4 in secure storage | `SecureDeviceIdStore` |
| Dates are `YYYY-MM-DD` strings | DTOs keep `String`; the form builds the string from the picked y/m/d |
| Enums decode with `unknown` | every enum + `@JsonKey(unknownEnumValue)`; tested |
| `relationshipCategory` never sent | `NewApplicant.toJson`; asserted |
| Screen 7 → `(stage, nullaOstaStatus)` | `StageChoice`; tracker patched first, stage last (both idempotent) |
| All strings through l10n | `core/l10n/app_en.arb` |
| No secrets / PII in logs | no logging added; no API secrets exist |

## 4. Test results
**68 tests green** (`flutter test`), `flutter analyze` clean, verified from a clean checkout (`pub get` → `build_runner` → analyze → test).
- Contract (11): decode REAL server output for every DTO; unknown enums.
- Network (20): headers, error mapping, refresh-once, terminal codes, retry rules.
- Session (11) and router (11): cold start vs register, terminal notices, single-flight, stale-resume window, every onboarding state.
- Repositories (6): request shapes.
- Flows (10): full new-user journey against a stateful fake of the API's state machine; returning user; read-only banner; case-not-generated; login failure; offline splash retry; evicted-device notice; applicant limit; legal version bump.
Mutation check: removing the legal redirect or the refresh-once guard fails tests.

## 5. Not verified here
- **No Android build.** No Android SDK/emulator in this environment: Gradle (flavors, the conditional google-services plugin), the manifest and real Firebase sign-in are unbuilt. First `flutter build apk --flavor dev` is the check.
- No real Firebase/`google-services.json`; no FCM; no run against staging (`integration_test` not written — needs a staging stack).
- Dashboard shows readiness/blocking from the server; the checklist screens it links to don't exist yet.

## 6. Owner actions
- Application id `pk.visaitaly.app` is approved; create the 3 Firebase Android apps; add `android/app/src/{dev,staging,prod}/google-services.json` (the plugin applies only when all three exist).
- Build with `--dart-define=API_BASE_URL=https://…` for staging/prod (dev defaults to `http://10.0.2.2:8787`).
- Enable Email/Password sign-in in each Firebase project.
