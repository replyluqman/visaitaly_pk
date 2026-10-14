import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/app/router.dart';
import 'package:visaitaly_pk/core/models/enums.dart';
import 'package:visaitaly_pk/core/network/api_error.dart';
import 'package:visaitaly_pk/core/session/session_state.dart';
import 'package:visaitaly_pk/features/auth/data/dto/me_dto.dart';

SessionReady ready({
  OnboardingState state = OnboardingState.complete,
  bool legalPending = false,
  int? declared,
  int total = 0,
  int awaiting = 0,
}) =>
    SessionReady(MeResponse(
      user: UserDto(id: 'u', onboardingState: state, createdAt: '2026-01-01T00:00:00Z'),
      entitlement: const EntitlementDto(),
      devices: const DevicesDto(maxActive: 2, activeCount: 1),
      legal: LegalStateDto(requiresAcceptance: legalPending, pendingDocTypes: legalPending ? [LegalDocType.disclaimer] : []),
      applicants: ApplicantsSummaryDto(declaredCount: declared, total: total, awaitingStage: awaiting),
    ));

void main() {
  group('no snapshot yet', () {
    test('loading and failed → Splash from anywhere', () {
      for (final s in [const SessionLoading(), const SessionFailed(ApiError(code: 'NETWORK', message: 'x'))]) {
        expect(computeRedirect(s, Routes.home), Routes.splash);
        expect(computeRedirect(s, Routes.splash), isNull);
      }
    });
    test('signed out → Login from anywhere (deep links included)', () {
      const s = SessionSignedOut();
      expect(computeRedirect(s, Routes.home), Routes.login);
      expect(computeRedirect(s, Routes.addApplicant), Routes.login);
      expect(computeRedirect(s, Routes.login), isNull);
    });
  });

  group('legal gate wins over onboarding state', () {
    test('requiresAcceptance → /legal even for a user whose onboarding is complete (version bump)', () {
      final s = ready(legalPending: true);
      expect(computeRedirect(s, Routes.home), Routes.legal);
      expect(computeRedirect(s, Routes.legal), isNull);
    });
    test('disclaimer_pending → /legal', () {
      expect(computeRedirect(ready(state: OnboardingState.disclaimerPending, legalPending: true), Routes.login), Routes.legal);
    });
  });

  group('onboarding follows the SERVER state', () {
    test('applicants_pending with no declared count → count screen', () {
      final s = ready(state: OnboardingState.applicantsPending);
      expect(computeRedirect(s, Routes.legal), Routes.count);
      expect(computeRedirect(s, Routes.count), isNull);
      expect(computeRedirect(s, Routes.home), Routes.count);
    });
    test('applicants_pending with a declared count → add-applicant screen', () {
      final s = ready(state: OnboardingState.applicantsPending, declared: 2, total: 1);
      expect(computeRedirect(s, Routes.count), Routes.applicant);
      expect(computeRedirect(s, Routes.applicant), isNull);
      expect(computeRedirect(s, Routes.home), Routes.applicant);
    });
    test('stage_pending → stage screen', () {
      final s = ready(state: OnboardingState.stagePending, declared: 1, total: 1, awaiting: 1);
      expect(computeRedirect(s, Routes.applicant), Routes.stage);
      expect(computeRedirect(s, Routes.stage), isNull);
    });
    test('complete → Home; auth/onboarding screens are dead ends, sub-routes are fine', () {
      final s = ready();
      for (final p in [Routes.splash, Routes.login, Routes.legal, Routes.count, Routes.applicant, Routes.stage]) {
        expect(computeRedirect(s, p), Routes.home, reason: p);
      }
      expect(computeRedirect(s, Routes.home), isNull);
      expect(computeRedirect(s, Routes.addApplicant), isNull);
    });
    test('an unknown future onboarding state is treated as complete rather than bricking the app', () {
      expect(computeRedirect(ready(state: OnboardingState.unknown), Routes.splash), Routes.home);
    });
  });
}
