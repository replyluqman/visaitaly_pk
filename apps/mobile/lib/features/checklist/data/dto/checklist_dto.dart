import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../../core/models/enums.dart';
import '../../../documents/data/dto/document_dto.dart';

part 'checklist_dto.freezed.dart';
part 'checklist_dto.g.dart';

@freezed
abstract class ChecklistItem with _$ChecklistItem {
  const factory ChecklistItem({
    required String id,
    required String requirementCode,
    @JsonKey(unknownEnumValue: JourneyStage.unknown) required JourneyStage stage,
    required String title,
    @JsonKey(unknownEnumValue: ItemStatus.unknown) required ItemStatus status,
    @Default([]) @JsonKey(unknownEnumValue: ItemBadge.unknown) List<ItemBadge> badges,
    String? notApplicableReason,
    @Default(false) bool translationRequired,
    @Default(false) bool apostilleRequired,
    String? lastVerifiedAt,
    @Default(1) int requirementVersion,
    @Default(0) int documentCount,
    required String updatedAt,
  }) = _ChecklistItem;
  factory ChecklistItem.fromJson(Map<String, dynamic> json) => _$ChecklistItemFromJson(json);
}

@freezed
abstract class SourceDto with _$SourceDto {
  const factory SourceDto({required String name, required String url, String? document, String? publishedAt}) = _SourceDto;
  factory SourceDto.fromJson(Map<String, dynamic> json) => _$SourceDtoFromJson(json);
}

/// GET /v1/checklist/:id — the merged detail + documents screen (Screen 11).
@freezed
abstract class ChecklistItemDetail with _$ChecklistItemDetail {
  const factory ChecklistItemDetail({
    required String id,
    required String requirementCode,
    @JsonKey(unknownEnumValue: JourneyStage.unknown) required JourneyStage stage,
    required String title,
    @JsonKey(unknownEnumValue: ItemStatus.unknown) required ItemStatus status,
    @Default([]) @JsonKey(unknownEnumValue: ItemBadge.unknown) List<ItemBadge> badges,
    String? notApplicableReason,
    @Default(false) bool translationRequired,
    @Default(false) bool apostilleRequired,
    String? lastVerifiedAt,
    @Default(1) int requirementVersion,
    @Default(0) int documentCount,
    required String updatedAt,

    /// The applicant this item belongs to (Today / notification deep links open an item without its case).
    required String applicantId,
    String? purpose,
    String? whoProvides,
    String? whereToObtain,
    String? recommendedTiming,
    String? conditionNote,
    SourceDto? source,
    @Default([]) List<DocumentDto> documents,
    @Default(false) bool canWrite,
    @Default(30) int staleAfterDays,
  }) = _ChecklistItemDetail;
  factory ChecklistItemDetail.fromJson(Map<String, dynamic> json) => _$ChecklistItemDetailFromJson(json);
}

@freezed
abstract class ChecklistResponse with _$ChecklistResponse {
  const factory ChecklistResponse({
    required String applicantId,
    @Default([]) List<ChecklistItem> items,

    /// Free tier: applicable items behind the paywall ("+18 more documents").
    @Default(0) int lockedCount,
    String? nextCursor,
    required String syncedAt,
  }) = _ChecklistResponse;
  factory ChecklistResponse.fromJson(Map<String, dynamic> json) => _$ChecklistResponseFromJson(json);
}

@freezed
abstract class JourneyStageSummary with _$JourneyStageSummary {
  const factory JourneyStageSummary({
    @JsonKey(unknownEnumValue: JourneyStage.unknown) required JourneyStage stage,
    @JsonKey(unknownEnumValue: StageState.unknown) required StageState state,
    @Default(0) int itemCount,
    @Default(0) int readyCount,
  }) = _JourneyStageSummary;
  factory JourneyStageSummary.fromJson(Map<String, dynamic> json) => _$JourneyStageSummaryFromJson(json);
}

@freezed
abstract class JourneyResponse with _$JourneyResponse {
  const factory JourneyResponse({
    @JsonKey(unknownEnumValue: JourneyStage.unknown) JourneyStage? currentStage,
    @Default([]) List<JourneyStageSummary> stages,
  }) = _JourneyResponse;
  factory JourneyResponse.fromJson(Map<String, dynamic> json) => _$JourneyResponseFromJson(json);
}
