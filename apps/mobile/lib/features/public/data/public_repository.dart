import 'package:dio/dio.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors.dart';
import 'dto/public_dto.dart';

/// Unauthenticated endpoints: no token and no device id are sent (the Quick Check runs before any account exists).
class PublicRepository {
  PublicRepository(this._dio);
  final Dio _dio;

  static final _public = Options(extra: {Extra.noAuth: true, Extra.noDevice: true});

  Future<VerificationSummary> verificationSummary() => apiCall(
        () => _dio.get<dynamic>('/v1/public/verification-summary', options: _public),
        (j) => VerificationSummary.fromJson(j! as Map<String, dynamic>),
      );

  Future<EligibilityQuestionSet> eligibilityQuestions({String locale = 'en'}) => apiCall(
        () => _dio.get<dynamic>('/v1/public/eligibility-check', queryParameters: {'locale': locale}, options: _public),
        (j) => EligibilityQuestionSet.fromJson(j! as Map<String, dynamic>),
      );

  /// Stateless: nothing is stored. A stale `version` is a 422 with `details.version` — reload the questions.
  Future<EligibilityResult> submitEligibility({required int version, required Map<String, String> answers, String locale = 'en'}) => apiCall(
        () => _dio.post<dynamic>(
          '/v1/public/eligibility-check',
          queryParameters: {'locale': locale},
          data: {'version': version, 'answers': answers},
          options: _public,
        ),
        (j) => EligibilityResult.fromJson(j! as Map<String, dynamic>),
      );
}
