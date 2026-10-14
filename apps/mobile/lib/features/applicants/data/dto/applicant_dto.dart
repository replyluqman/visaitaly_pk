import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../../core/models/enums.dart';

part 'applicant_dto.freezed.dart';
part 'applicant_dto.g.dart';

/// Calendar dates (`dateOfBirth`, Nulla Osta dates) stay `String` `YYYY-MM-DD` — never DateTime, which
/// shifts the day across time zones.
@freezed
abstract class NullaOstaDto with _$NullaOstaDto {
  const factory NullaOstaDto({
    @JsonKey(unknownEnumValue: NullaOstaStatus.unknown) required NullaOstaStatus status,
    String? issueDate,
    String? expiryDate,
    int? daysRemaining,
  }) = _NullaOstaDto;
  factory NullaOstaDto.fromJson(Map<String, dynamic> json) => _$NullaOstaDtoFromJson(json);
}

@freezed
abstract class AccessDto with _$AccessDto {
  const factory AccessDto({
    @JsonKey(unknownEnumValue: AccessLevel.unknown) required AccessLevel level,
    required bool canWrite,
    String? accessUntil,
    String? graceUntil,
  }) = _AccessDto;
  factory AccessDto.fromJson(Map<String, dynamic> json) => _$AccessDtoFromJson(json);
}

@freezed
abstract class ReadinessDto with _$ReadinessDto {
  const factory ReadinessDto({
    @Default(0) num percent,
    @Default(0) int applicableCount,
    @Default(0) int readyCount,
    @Default(0) int blockingCount,
    @Default(0) int notApplicableCount,
    @Default(0) int categorySpecificCount,
  }) = _ReadinessDto;
  factory ReadinessDto.fromJson(Map<String, dynamic> json) => _$ReadinessDtoFromJson(json);
}

@freezed
abstract class Applicant with _$Applicant {
  const factory Applicant({
    required String id,
    required String displayName,
    required String relationshipCode,
    required String relationshipLabel,
    @JsonKey(unknownEnumValue: RelationshipCategory.unknown) required RelationshipCategory relationshipCategory,
    String? dateOfBirth,
    @JsonKey(unknownEnumValue: ApplicantLocation.unknown) required ApplicantLocation currentLocation,

    /// Null = Screen 7 has not run for this applicant yet.
    @JsonKey(unknownEnumValue: JourneyStage.unknown) JourneyStage? currentStage,
    String? stageUpdatedAt,
    String? caseGeneratedAt,
    required NullaOstaDto nullaOsta,
    required AccessDto access,
    @Default(ReadinessDto()) ReadinessDto readiness,
    required String createdAt,
  }) = _Applicant;
  factory Applicant.fromJson(Map<String, dynamic> json) => _$ApplicantFromJson(json);
}

@freezed
abstract class ApplicantListResponse with _$ApplicantListResponse {
  const factory ApplicantListResponse({
    @Default([]) List<Applicant> applicants,
    required int maxApplicants,
  }) = _ApplicantListResponse;
  factory ApplicantListResponse.fromJson(Map<String, dynamic> json) => _$ApplicantListResponseFromJson(json);
}

@freezed
abstract class RelationshipOption with _$RelationshipOption {
  const factory RelationshipOption({
    required String code,
    required String label,
    @JsonKey(unknownEnumValue: RelationshipCategory.unknown) required RelationshipCategory category,
    required bool requiresDob,
  }) = _RelationshipOption;
  factory RelationshipOption.fromJson(Map<String, dynamic> json) => _$RelationshipOptionFromJson(json);
}

/// POST /v1/applicants and PATCH …/stage answer with the applicant plus the recomputed onboarding state.
@freezed
abstract class ApplicantWithState with _$ApplicantWithState {
  const factory ApplicantWithState({
    required Applicant applicant,
    @JsonKey(unknownEnumValue: OnboardingState.unknown) required OnboardingState onboardingState,
  }) = _ApplicantWithState;
  factory ApplicantWithState.fromJson(Map<String, dynamic> json) => _$ApplicantWithStateFromJson(json);
}
