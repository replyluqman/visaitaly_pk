import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../../core/models/enums.dart';

part 'account_dto.freezed.dart';
part 'account_dto.g.dart';

@freezed
abstract class Consents with _$Consents {
  const factory Consents({
    @Default(false) bool analytics,
    @Default(false) bool crashReports,
    @Default(false) bool marketingPush,
    String? policyVersion,

    /// False until the user has answered once — the client asks then.
    @Default(false) bool answered,
  }) = _Consents;
  factory Consents.fromJson(Map<String, dynamic> json) => _$ConsentsFromJson(json);
}

@freezed
abstract class DeviceSummary with _$DeviceSummary {
  const factory DeviceSummary({
    required String deviceId,
    required String platform,
    String? model,
    String? appVersion,
    required String lastLoginAt,
    required String lastSeenAt,
    @Default(false) bool isCurrent,
  }) = _DeviceSummary;
  factory DeviceSummary.fromJson(Map<String, dynamic> json) => _$DeviceSummaryFromJson(json);
}

@freezed
abstract class DataRequestAccepted with _$DataRequestAccepted {
  const factory DataRequestAccepted({
    required String requestId,
    @JsonKey(unknownEnumValue: DataRequestStatus.unknown) required DataRequestStatus status,
  }) = _DataRequestAccepted;
  factory DataRequestAccepted.fromJson(Map<String, dynamic> json) => _$DataRequestAcceptedFromJson(json);
}

@freezed
abstract class DataExportStatus with _$DataExportStatus {
  const factory DataExportStatus({
    required String id,
    @JsonKey(unknownEnumValue: DataRequestStatus.unknown) required DataRequestStatus status,
    required String requestedAt,
    String? completedAt,
    String? expiresAt,
    String? downloadUrl,
  }) = _DataExportStatus;
  factory DataExportStatus.fromJson(Map<String, dynamic> json) => _$DataExportStatusFromJson(json);
}
