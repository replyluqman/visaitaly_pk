# 0009 — Flutter stack: Riverpod, Dio, go_router, freezed
Status: Accepted | Date: 2026-09

## Decision
Riverpod for state, Dio with hand-written repository classes (no Retrofit codegen),
go_router with redirect guards driven by `/v1/me`, freezed + json_serializable models
mirroring `@visaitaly/shared`, `flutter_secure_storage` for the device UUID,
`flutter_test` + `mocktail` + `integration_test`.

## Consequences
Models are mirrored by hand — a contract test (golden JSON from the API) catches
drift. Details: `docs/FLUTTER-ARCHITECTURE.md`.

## Alternatives considered
Bloc (more boilerplate for this size), Retrofit (codegen + less control over the
error interceptor), Provider (superseded by Riverpod).
