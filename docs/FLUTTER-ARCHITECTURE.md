# Flutter architecture

Stack is locked (ADR 0009). Android first; nothing may block iOS later.
Items marked **DECIDE** are not settled and must not be chosen silently.

## Project layout (`apps/mobile`)

```
lib/
  main_dev.dart · main_staging.dart · main_prod.dart   # one entry per flavor
  app/            app.dart, router.dart (go_router + guards), theme/
  core/
    config/       AppConfig per flavor (API base URL, Firebase options)
    network/      dio_client.dart, interceptors/ (auth, device, error), api_error.dart
    storage/      secure_storage.dart (device UUID), local_db/ (Module 3)
    session/      session_controller.dart  — owns the /v1/me snapshot
    l10n/         ARB files (en now; ur gated by PRD §11a)
  features/
    <feature>/
      data/       <feature>_repository.dart, dto/ (freezed)
      domain/     models used by UI if different from DTOs
      presentation/ screens/, widgets/, <feature>_controller.dart (Riverpod)
test/             unit + widget, mirrors lib/
integration_test/ end-to-end flows against staging
```

Feature folders match backend modules: `auth`, `legal`, `onboarding`, `applicants`,
then `checklist`, `notifications`, `orders`, `services`, `support`, `referral`.

## Layers

`Screen → Controller (Riverpod Notifier/AsyncNotifier) → Repository → Dio`.
Screens never call Dio. Repositories return models or throw `ApiError`; they hold no
state. Controllers hold state and are the only place business flow lives on the client.

## Networking

One `Dio` instance (provider), base URL from flavor config, timeouts 15 s.

Interceptors, in order:
1. **Auth** — attach `Authorization: Bearer <await user.getIdToken()>` (Firebase
   refreshes it when near expiry).
2. **Device** — attach `X-Device-Id` from secure storage (generated once, UUIDv4).
3. **Error** — map every non-2xx to `ApiError(code, message, details, requestId, status)`
   using the shared error body. Unknown code → treat as `INTERNAL`.

Terminal handling (`SESSION_TERMINAL_CODES`):

- `UNAUTHENTICATED`: force-refresh the token (`getIdToken(true)`) and retry the request
  **once**. Only if it fails again: sign out. Reason: the server returns the same code
  when it cannot fetch Google's keys; without the retry a Google/KV blip logs out
  every user.
- `DEVICE_UNKNOWN`, `DEVICE_EVICTED`, `DEVICE_SIGNED_OUT`, `USER_DELETED`: clear local
  state, `FirebaseAuth.signOut()`, route to Login with the matching notice. No retry.
- Guard against a burst of parallel 401s triggering several sign-outs (single-flight).

Retries: only idempotent requests (GET, `POST /v1/auth/session`, PUT-like PATCHes),
on network errors and 5xx, max 2, with backoff. Never retry 4xx.

## Session and routing

`SessionController` holds the latest `MeResponse`. Sources: `POST /v1/auth/session`
after every sign-in, `GET /v1/me` on every cold start and on resume after > N minutes
(**DECIDE** N; suggest 30).

go_router `redirect`, evaluated in this order:
1. No Firebase user → Login.
2. No session snapshot yet → Splash.
3. `legal.requiresAcceptance` → Disclaimer Gate (also for existing users after a version bump).
4. `onboardingState`: `applicants_pending` → Applicant count / add applicant;
   `stage_pending` → Stage selection for the first applicant with `currentStage == null`;
   `complete` → Family Dashboard.

Never route on local flags. The server state is the truth.

Per-applicant UI uses `applicant.access.level` / `canWrite`; `APPLICANT_READ_ONLY` from
the server is the backstop, not the primary check.

## Models

freezed + json_serializable DTOs mirror `packages/shared` by hand. Enums use
`@JsonEnum` with an `unknown` fallback value so a new server value never crashes an
old app. Dates: calendar dates stay `String` (`YYYY-MM-DD`) or a dedicated `LocalDate`
type — never `DateTime` (timezone shift). **Contract test:** golden JSON captured from
the staging API, decoded in a unit test per DTO.

## Local storage

- `flutter_secure_storage`: device UUID only. No API secrets exist on the client.
- Relationships list: cache with a TTL (changes rarely).
- Checklist offline cache + conflict resolution (PRD §12): **DECIDE in Module 3**
  (candidates: drift, sqflite). Not needed before then.

## Flavors

`dev` (local API / emulator), `staging`, `prod` — separate Firebase projects
(`google-services.json` per flavor) and API base URLs. A staging build can never
talk to production (token audience differs).

## Testing (per module, alongside backend gates)

| Level | Tool | Covers |
|---|---|---|
| Unit | flutter_test + mocktail | repositories (mock Dio), controllers, interceptor logic incl. refresh-once |
| Widget | flutter_test | each screen's states: loading, error, empty, read-only |
| Contract | golden JSON | DTO decode for every endpoint used |
| Integration | integration_test | sign-in → onboarding → dashboard against staging |

## Release

Play Console internal → closed → production. `minSdk` / `targetSdk` per current Play
requirements — **verify at setup**. App version sent as `appVersion` on session
registration; keep the API backward-compatible with every version still installed.

## Before writing the first screen

1. `flutter create` with org id (**DECIDE**: e.g. `pk.visaitaly.app` — must match the
   Firebase Android app).
2. Flavors + Firebase per flavor.
3. `core/network` + `core/session` + router guards with tests — the skeleton every
   feature depends on.

## Decisions taken in the skeleton (F1) — change by editing here

| Item | Decision | Why / how to change |
|---|---|---|
| Resume refresh window (N) | 30 min, `AppConfig.resumeRefreshAfter` | Was **DECIDE**; suggested value used. One constant. |
| Application id | `pk.visaitaly.app` (+ `.dev`, `.staging`) | Still **DECIDE** for the owner — must match the Firebase Android app and is permanent after the first Play upload. |
| Sign-in methods | Email + password only | Google Sign-In needs `google_sign_in` + SHA-1 registration; add behind `AuthGateway`. |
| Generated code | `*.g.dart`, `*.freezed.dart`, l10n output are **not committed** | CI and local setup run `flutter pub get` + `dart run build_runner build`. |
| Contract fixtures | Captured from the API's own handlers by `apps/api/test/mobile-fixtures.test.ts` (`MOBILE_FIXTURES_DIR=../mobile/test/fixtures pnpm test test/mobile-fixtures`) | Replaces "capture from staging"; regenerate after any response-shape change. |
| Firebase seam | `AuthGateway` interface; `FirebaseAuthGateway` is the only SDK user | Keeps all logic testable without a Firebase project. |
