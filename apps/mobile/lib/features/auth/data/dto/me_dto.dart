import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../../core/models/enums.dart';

part 'me_dto.freezed.dart';
part 'me_dto.g.dart';

@freezed
abstract class UserDto with _$UserDto {
  const factory UserDto({
    required String id,
    String? email,
    String? displayName,
    @JsonKey(unknownEnumValue: OnboardingState.unknown) required OnboardingState onboardingState,
    required String createdAt,
  }) = _UserDto;
  factory UserDto.fromJson(Map<String, dynamic> json) => _$UserDtoFromJson(json);
}

@freezed
abstract class EntitlementDto with _$EntitlementDto {
  const factory EntitlementDto({
    @Default([]) List<String> premiumApplicantIds,
    @Default([]) List<String> graceApplicantIds,
    @Default(false) bool hasAnyPremium,
  }) = _EntitlementDto;
  factory EntitlementDto.fromJson(Map<String, dynamic> json) => _$EntitlementDtoFromJson(json);
}

@freezed
abstract class DevicesDto with _$DevicesDto {
  const factory DevicesDto({required int maxActive, required int activeCount}) = _DevicesDto;
  factory DevicesDto.fromJson(Map<String, dynamic> json) => _$DevicesDtoFromJson(json);
}

@freezed
abstract class LegalStateDto with _$LegalStateDto {
  const factory LegalStateDto({
    required bool requiresAcceptance,
    @Default([]) @JsonKey(unknownEnumValue: LegalDocType.unknown) List<LegalDocType> pendingDocTypes,
  }) = _LegalStateDto;
  factory LegalStateDto.fromJson(Map<String, dynamic> json) => _$LegalStateDtoFromJson(json);
}

@freezed
abstract class ApplicantsSummaryDto with _$ApplicantsSummaryDto {
  const factory ApplicantsSummaryDto({
    int? declaredCount,
    required int total,
    required int awaitingStage,
  }) = _ApplicantsSummaryDto;
  factory ApplicantsSummaryDto.fromJson(Map<String, dynamic> json) => _$ApplicantsSummaryDtoFromJson(json);
}

/// GET /v1/me — and the body of POST /v1/auth/session, which adds `session`.
@freezed
abstract class MeResponse with _$MeResponse {
  const factory MeResponse({
    required UserDto user,
    required EntitlementDto entitlement,
    required DevicesDto devices,
    required LegalStateDto legal,
    required ApplicantsSummaryDto applicants,
  }) = _MeResponse;
  factory MeResponse.fromJson(Map<String, dynamic> json) => _$MeResponseFromJson(json);
}

@freezed
abstract class SessionInfoDto with _$SessionInfoDto {
  const factory SessionInfoDto({
    @Default([]) List<String> evictedDeviceIds,
    @Default(false) bool isNewUser,
  }) = _SessionInfoDto;
  factory SessionInfoDto.fromJson(Map<String, dynamic> json) => _$SessionInfoDtoFromJson(json);
}
