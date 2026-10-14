import 'package:freezed_annotation/freezed_annotation.dart';

part 'public_dto.freezed.dart';
part 'public_dto.g.dart';

@freezed
abstract class RecentUpdate with _$RecentUpdate {
  const factory RecentUpdate({required String requirementTitle, String? changeSummary, required String effectiveDate}) = _RecentUpdate;
  factory RecentUpdate.fromJson(Map<String, dynamic> json) => _$RecentUpdateFromJson(json);
}

/// GET /v1/public/verification-summary — the "How We Verify" stats (Screen 15).
@freezed
abstract class VerificationSummary with _$VerificationSummary {
  const factory VerificationSummary({
    @Default(0) int requirementsTracked,
    @Default(0) num sourceLinkedPercent,
    String? lastSweepAt,
    @Default(0) int openFlags,
    @Default([]) List<RecentUpdate> recentUpdates,
  }) = _VerificationSummary;
  factory VerificationSummary.fromJson(Map<String, dynamic> json) => _$VerificationSummaryFromJson(json);
}

@freezed
abstract class EligibilityOption with _$EligibilityOption {
  const factory EligibilityOption({required String value, required String label}) = _EligibilityOption;
  factory EligibilityOption.fromJson(Map<String, dynamic> json) => _$EligibilityOptionFromJson(json);
}

@freezed
abstract class EligibilityQuestion with _$EligibilityQuestion {
  const factory EligibilityQuestion({
    required String id,
    required String text,
    @Default([]) List<EligibilityOption> options,
  }) = _EligibilityQuestion;
  factory EligibilityQuestion.fromJson(Map<String, dynamic> json) => _$EligibilityQuestionFromJson(json);
}

@freezed
abstract class EligibilityQuestionSet with _$EligibilityQuestionSet {
  const factory EligibilityQuestionSet({
    required int version,
    required String disclaimer,
    @Default([]) List<EligibilityQuestion> questions,
  }) = _EligibilityQuestionSet;
  factory EligibilityQuestionSet.fromJson(Map<String, dynamic> json) => _$EligibilityQuestionSetFromJson(json);
}

@freezed
abstract class TypicalItem with _$TypicalItem {
  const factory TypicalItem({required String title, String? why}) = _TypicalItem;
  factory TypicalItem.fromJson(Map<String, dynamic> json) => _$TypicalItemFromJson(json);
}

/// Orientation only — never a verdict. Every word is CMS-owned.
@freezed
abstract class EligibilityResult with _$EligibilityResult {
  const factory EligibilityResult({
    required String summary,
    @Default([]) List<TypicalItem> typicalItems,
    @Default(0) int lockedCount,
    required String disclaimer,
    String? whatsappUrl,
  }) = _EligibilityResult;
  factory EligibilityResult.fromJson(Map<String, dynamic> json) => _$EligibilityResultFromJson(json);
}
