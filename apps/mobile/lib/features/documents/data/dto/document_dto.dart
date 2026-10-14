import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../../core/models/enums.dart';

part 'document_dto.freezed.dart';
part 'document_dto.g.dart';

@freezed
abstract class DocumentDto with _$DocumentDto {
  const factory DocumentDto({
    required String id,
    required String applicantId,
    String? checklistItemId,
    required String mime,
    required int sizeBytes,

    /// `YYYY-MM-DD` — a String, never a DateTime.
    String? expiryDate,
    required String createdAt,

    /// Short-lived signed GET; present on detail only.
    String? viewUrl,
  }) = _DocumentDto;
  factory DocumentDto.fromJson(Map<String, dynamic> json) => _$DocumentDtoFromJson(json);
}

@freezed
abstract class QuotaDto with _$QuotaDto {
  const factory QuotaDto({required int usedBytes, required int maxBytes}) = _QuotaDto;
  factory QuotaDto.fromJson(Map<String, dynamic> json) => _$QuotaDtoFromJson(json);
}

@freezed
abstract class DocumentList with _$DocumentList {
  const factory DocumentList({
    @Default([]) List<DocumentDto> items,
    String? nextCursor,
    required QuotaDto quota,
  }) = _DocumentList;
  factory DocumentList.fromJson(Map<String, dynamic> json) => _$DocumentListFromJson(json);
}

/// Reserve → PUT bytes (no session) → complete.
@freezed
abstract class UploadReservation with _$UploadReservation {
  const factory UploadReservation({
    required String id,
    required String uploadUrl,
    required String expiresAt,
    @Default({}) Map<String, String> requiredHeaders,
  }) = _UploadReservation;
  factory UploadReservation.fromJson(Map<String, dynamic> json) => _$UploadReservationFromJson(json);
}

@freezed
abstract class TodayAction with _$TodayAction {
  const factory TodayAction({
    @JsonKey(unknownEnumValue: TodayKind.unknown) required TodayKind kind,
    @JsonKey(unknownEnumValue: TodayReason.unknown) required TodayReason reason,
    String? title,
    required String applicantId,
    String? itemId,
    String? dueDate,
    required String deepLink,
  }) = _TodayAction;
  factory TodayAction.fromJson(Map<String, dynamic> json) => _$TodayActionFromJson(json);
}

@freezed
abstract class AllClear with _$AllClear {
  const factory AllClear({@JsonKey(unknownEnumValue: JourneyStage.unknown) JourneyStage? nextStage}) = _AllClear;
  factory AllClear.fromJson(Map<String, dynamic> json) => _$AllClearFromJson(json);
}

@freezed
abstract class TodayResponse with _$TodayResponse {
  const factory TodayResponse({
    @Default([]) List<TodayAction> actions,
    AllClear? allClear,

    /// Null = not computed yet: show nothing, NOT "all clear".
    String? computedAt,
  }) = _TodayResponse;
  factory TodayResponse.fromJson(Map<String, dynamic> json) => _$TodayResponseFromJson(json);
}
