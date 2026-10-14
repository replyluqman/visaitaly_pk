import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../../core/models/enums.dart';

part 'legal_dto.freezed.dart';
part 'legal_dto.g.dart';

@freezed
abstract class LegalVersionSummary with _$LegalVersionSummary {
  const factory LegalVersionSummary({
    required String id,
    @JsonKey(unknownEnumValue: LegalDocType.unknown) required LegalDocType docType,
    required String locale,
    required String version,
    required String title,
    @Default(true) bool isMandatory,
    String? publishedAt,
    @Default(false) bool accepted,
  }) = _LegalVersionSummary;
  factory LegalVersionSummary.fromJson(Map<String, dynamic> json) => _$LegalVersionSummaryFromJson(json);
}

@freezed
abstract class CurrentLegalResponse with _$CurrentLegalResponse {
  const factory CurrentLegalResponse({
    @Default([]) List<LegalVersionSummary> documents,
    required bool requiresAcceptance,
  }) = _CurrentLegalResponse;
  factory CurrentLegalResponse.fromJson(Map<String, dynamic> json) => _$CurrentLegalResponseFromJson(json);
}

@freezed
abstract class LegalDocumentResponse with _$LegalDocumentResponse {
  const factory LegalDocumentResponse({
    required String id,
    @JsonKey(unknownEnumValue: LegalDocType.unknown) required LegalDocType docType,
    required String version,
    required String title,
    required String bodyMd,
    @Default(false) bool accepted,
  }) = _LegalDocumentResponse;
  factory LegalDocumentResponse.fromJson(Map<String, dynamic> json) => _$LegalDocumentResponseFromJson(json);
}
