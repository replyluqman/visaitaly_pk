import 'package:dio/dio.dart';

import '../../../core/models/enums.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors.dart';
import 'dto/applicant_dto.dart';

class NewApplicant {
  const NewApplicant({
    required this.displayName,
    required this.relationshipCode,
    required this.currentLocation,
    this.dateOfBirth,
    this.nullaOstaStatus,
    this.currentStage,
  });
  final String displayName;
  final String relationshipCode;
  final ApplicantLocation currentLocation;

  /// `YYYY-MM-DD`, required when the relationship's `requiresDob`.
  final String? dateOfBirth;
  final NullaOstaStatus? nullaOstaStatus;
  final JourneyStage? currentStage;

  /// `relationshipCategory` is deliberately absent: the server derives it and never accepts it from a client.
  Map<String, Object?> toJson() => {
        'displayName': displayName.trim(),
        'relationshipCode': relationshipCode,
        'currentLocation': wire(currentLocation),
        'dateOfBirth': ?dateOfBirth,
        if (nullaOstaStatus != null) 'nullaOstaStatus': wire(nullaOstaStatus!),
        if (currentStage != null) 'currentStage': wire(currentStage!),
      };
}

class ApplicantsRepository {
  ApplicantsRepository(this._dio);
  final Dio _dio;

  Future<ApplicantListResponse> list({String locale = 'en'}) => apiCall(
        () => _dio.get<dynamic>('/v1/applicants', queryParameters: {'locale': locale}),
        (j) => ApplicantListResponse.fromJson(j! as Map<String, dynamic>),
      );

  Future<List<RelationshipOption>> relationships({String locale = 'en'}) => apiCall(
        () => _dio.get<dynamic>('/v1/reference/relationships', queryParameters: {'locale': locale}),
        (j) => ((j! as Map<String, dynamic>)['relationships'] as List)
            .map((e) => RelationshipOption.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  /// PATCH /v1/onboarding/applicant-count (Screen 5).
  Future<OnboardingState> setApplicantCount(int count) => apiCall(
        () => _dio.patch<dynamic>(
          '/v1/onboarding/applicant-count',
          data: {'declaredApplicantCount': count},
          options: Options(extra: {Extra.idempotent: true}),
        ),
        (j) => _stateOf(j),
      );

  /// POST is NOT retried: a lost response followed by a retry would create a duplicate applicant.
  Future<ApplicantWithState> create(NewApplicant input, {String locale = 'en'}) => apiCall(
        () => _dio.post<dynamic>('/v1/applicants', queryParameters: {'locale': locale}, data: input.toJson()),
        (j) => ApplicantWithState.fromJson(j! as Map<String, dynamic>),
      );

  Future<ApplicantWithState> setStage(String id, JourneyStage stage, {String locale = 'en'}) => apiCall(
        () => _dio.patch<dynamic>(
          '/v1/applicants/$id/stage',
          queryParameters: {'locale': locale},
          data: {'currentStage': wire(stage)},
          options: Options(extra: {Extra.idempotent: true}),
        ),
        (j) => ApplicantWithState.fromJson(j! as Map<String, dynamic>),
      );

  Future<Applicant> patch(String id, Map<String, Object?> fields, {String locale = 'en'}) => apiCall(
        () => _dio.patch<dynamic>(
          '/v1/applicants/$id',
          queryParameters: {'locale': locale},
          data: fields,
          options: Options(extra: {Extra.idempotent: true}),
        ),
        (j) => Applicant.fromJson(j! as Map<String, dynamic>),
      );

  static OnboardingState _stateOf(Object? j) {
    final raw = (j! as Map<String, dynamic>)['onboardingState'];
    return OnboardingState.values.firstWhere((s) => wire(s) == raw, orElse: () => OnboardingState.unknown);
  }
}
