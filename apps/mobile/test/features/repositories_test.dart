import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/models/enums.dart';
import 'package:visaitaly_pk/core/network/api_error.dart';
import 'package:visaitaly_pk/core/providers.dart';
import 'package:visaitaly_pk/features/applicants/data/applicants_repository.dart';

import '../helpers/fake_server.dart';
import '../helpers/fakes.dart';
import '../helpers/harness.dart';

void main() {
  late FakeServer server;
  late Harness h;
  late dynamic c;

  setUp(() {
    server = FakeServer()
      ..legalPending = false
      ..onboardingState = 'applicants_pending'
      ..declared = 2;
    h = harness(server.handle, user: const AuthUser(uid: 'u1'));
    c = h.container();
  });
  tearDown(() => c.dispose());

  ApplicantsRepository repo() => c.read(applicantsRepositoryProvider) as ApplicantsRepository;

  test('create sends wire values and NEVER relationshipCategory (server-derived, invariant 2)', () async {
    await repo().create(const NewApplicant(
      displayName: '  Ali  ',
      relationshipCode: 'son',
      currentLocation: ApplicantLocation.pakistan,
      dateOfBirth: '2015-03-02',
      nullaOstaStatus: NullaOstaStatus.inProcess,
    ));
    final sent = h.adapter.requests.firstWhere((r) => r.path == '/v1/applicants' && r.method == 'POST').data as Map;
    expect(sent, {
      'displayName': 'Ali',
      'relationshipCode': 'son',
      'currentLocation': 'pakistan',
      'dateOfBirth': '2015-03-02',
      'nullaOstaStatus': 'in_process',
    });
    expect(sent.containsKey('relationshipCategory'), isFalse);
    expect(sent.containsKey('currentStage'), isFalse); // Screen 7 sets it during onboarding
  });

  test('create is NOT retried after a network failure (a retry could create a duplicate applicant)', () async {
    h.adapter.responder = (_) => reply(0);
    await expectLater(
      repo().create(const NewApplicant(displayName: 'A', relationshipCode: 'wife', currentLocation: ApplicantLocation.italy)),
      throwsA(isA<ApiError>().having((e) => e.code, 'code', ApiCodes.network)),
    );
    expect(h.requestsTo('/v1/applicants'), hasLength(1));
  });

  test('setStage sends the snake_case stage and returns the recomputed onboarding state', () async {
    final created = await repo().create(const NewApplicant(displayName: 'A', relationshipCode: 'wife', currentLocation: ApplicantLocation.italy));
    final res = await repo().setStage(created.applicant.id, JourneyStage.nullaOsta);
    expect((h.requestsTo('/v1/applicants/${created.applicant.id}/stage').single.data as Map)['currentStage'], 'nulla_osta');
    expect(res.applicant.currentStage, JourneyStage.nullaOsta);
  });

  test('a validation failure surfaces per-field details', () async {
    h.adapter.responder = (_) => reply(422, errorBody('VALIDATION_FAILED', details: {'dateOfBirth': ['Date of birth is required for Son.']}));
    try {
      await repo().create(const NewApplicant(displayName: 'Ali', relationshipCode: 'son', currentLocation: ApplicantLocation.pakistan));
      fail('should throw');
    } on ApiError catch (e) {
      expect(e.code, ApiCodes.validationFailed);
      expect(e.details['dateOfBirth'], isNotEmpty);
    }
  });

  test('the session-registration body carries deviceId/platform/appVersion; optional fields are omitted', () async {
    await c.read(authRepositoryProvider).registerSession(
          deviceId: '11111111-1111-4111-8111-111111111111',
          app: testAppInfo,
        );
    final body = h.requestsTo('/v1/auth/session').single.data as Map;
    expect(body, {'deviceId': '11111111-1111-4111-8111-111111111111', 'platform': 'android', 'appVersion': '1.0.0'});
  });

  test('legal accept sends exactly the ids that were shown', () async {
    await c.read(legalRepositoryProvider).accept(['v1', 'v2'], appVersion: '1.0.0');
    expect(h.requestsTo('/v1/legal/accept').single.data, {'versionIds': ['v1', 'v2'], 'appVersion': '1.0.0'});
  });
}
