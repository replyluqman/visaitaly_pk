import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/models/enums.dart';
import 'package:visaitaly_pk/features/applicants/data/dto/applicant_dto.dart';
import 'package:visaitaly_pk/features/auth/data/dto/me_dto.dart';
import 'package:visaitaly_pk/features/legal/data/dto/legal_dto.dart';

import '../helpers/fakes.dart';

/// Decodes REAL server output (captured from the API's own handlers) into every DTO the app uses.
/// If the server changes a shape, regenerate the fixtures (see apps/api/test/mobile-fixtures.test.ts) and this
/// test names what broke.
void main() {
  group('MeResponse', () {
    test('disclaimer_pending: legal pending, no applicants', () {
      final me = MeResponse.fromJson(fixture('me_disclaimer_pending'));
      expect(me.user.onboardingState, OnboardingState.disclaimerPending);
      expect(me.legal.requiresAcceptance, isTrue);
      expect(me.legal.pendingDocTypes, [LegalDocType.disclaimer]);
      expect(me.applicants.declaredCount, isNull);
      expect(me.devices.maxActive, 2);
    });

    test('applicants_pending → stage_pending → complete', () {
      expect(MeResponse.fromJson(fixture('me_applicants_pending')).user.onboardingState, OnboardingState.applicantsPending);
      final stage = MeResponse.fromJson(fixture('me_stage_pending'));
      expect(stage.user.onboardingState, OnboardingState.stagePending);
      expect(stage.applicants.awaitingStage, 1);
      final done = MeResponse.fromJson(fixture('me_complete'));
      expect(done.user.onboardingState, OnboardingState.complete);
      expect(done.legal.requiresAcceptance, isFalse);
    });

    test('session registration carries the snapshot plus session info', () {
      final json = fixture('auth_session_evicted_device');
      expect(MeResponse.fromJson(json).user.id, isNotEmpty);
      final info = SessionInfoDto.fromJson(json['session'] as Map<String, dynamic>);
      expect(info.evictedDeviceIds, hasLength(1));
      expect(SessionInfoDto.fromJson(fixture('auth_session_new_user')['session'] as Map<String, dynamic>).isNewUser, isTrue);
    });

    test('an unknown onboarding state decodes to unknown instead of throwing', () {
      final json = fixture('me_complete');
      (json['user'] as Map<String, dynamic>)['onboardingState'] = 'brand_new_state';
      expect(MeResponse.fromJson(json).user.onboardingState, OnboardingState.unknown);
    });
  });

  group('legal', () {
    test('current list and document body', () {
      final cur = CurrentLegalResponse.fromJson(fixture('legal_current'));
      expect(cur.requiresAcceptance, isTrue);
      expect(cur.documents.first.docType, LegalDocType.disclaimer);
      expect(cur.documents.first.accepted, isFalse);
      final doc = LegalDocumentResponse.fromJson(fixture('legal_document'));
      expect(doc.bodyMd, isNotEmpty);
    });
  });

  group('applicants', () {
    test('list: dates stay strings, nullable stage, access and readiness decode', () {
      final res = ApplicantListResponse.fromJson(fixture('applicants_list'));
      final a = res.applicants.single;
      expect(res.maxApplicants, 10);
      expect(a.relationshipCategory, RelationshipCategory.spouse);
      expect(a.currentStage, JourneyStage.nullaOsta);
      expect(a.nullaOsta.status, NullaOstaStatus.received);
      expect(a.nullaOsta.issueDate, '2026-08-01'); // a String — a DateTime would shift the day across time zones
      expect(a.access.level, AccessLevel.free);
      expect(a.access.canWrite, isTrue);
      expect(a.readiness.blockingCount, 3);
      expect(a.caseGeneratedAt, isNotNull);
    });

    test('a freshly created applicant has a null stage and no case yet', () {
      final r = ApplicantWithState.fromJson(fixture('applicant_created_stage_pending'));
      expect(r.onboardingState, OnboardingState.stagePending);
      expect(r.applicant.currentStage, isNull);
      expect(r.applicant.caseGeneratedAt, isNull);
    });

    test('staging the last applicant completes onboarding', () {
      expect(ApplicantWithState.fromJson(fixture('applicant_staged_complete')).onboardingState, OnboardingState.complete);
    });

    test('relationships', () {
      final list = (fixture('relationships')['relationships'] as List)
          .map((e) => RelationshipOption.fromJson(e as Map<String, dynamic>))
          .toList();
      expect(list.map((r) => r.code), containsAll(['wife', 'son']));
      expect(list.firstWhere((r) => r.code == 'son').requiresDob, isTrue);
      expect(list.firstWhere((r) => r.code == 'wife').requiresDob, isFalse);
    });

    test('unknown enum values never crash an old app', () {
      final json = fixture('applicants_list');
      final a = (json['applicants'] as List).first as Map<String, dynamic>;
      a['currentStage'] = 'a_future_stage';
      (a['access'] as Map<String, dynamic>)['level'] = 'platinum';
      a['currentLocation'] = 'mars';
      final decoded = ApplicantListResponse.fromJson(json).applicants.single;
      expect(decoded.currentStage, JourneyStage.unknown);
      expect(decoded.access.level, AccessLevel.unknown);
      expect(decoded.currentLocation, ApplicantLocation.unknown);
    });
  });

  test('wire() produces the server\'s snake_case values', () {
    expect(wire(JourneyStage.nullaOsta), 'nulla_osta');
    expect(wire(NullaOstaStatus.inProcess), 'in_process');
    expect(wire(ApplicantLocation.pakistan), 'pakistan');
  });
}
