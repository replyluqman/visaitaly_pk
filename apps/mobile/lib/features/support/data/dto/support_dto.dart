import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../../core/models/enums.dart';

part 'support_dto.freezed.dart';
part 'support_dto.g.dart';

@freezed
abstract class SupportThreadView with _$SupportThreadView {
  const factory SupportThreadView({
    @JsonKey(unknownEnumValue: SupportStatus.unknown) required SupportStatus status,
    @JsonKey(unknownEnumValue: SupportTier.unknown) required SupportTier tier,

    /// Working-hours-computed deadline; shown ONLY beside [workingHoursText] (PRD §14a).
    String? slaDueAt,
    @Default(0) int unreadCount,
    String? workingHoursText,
    @Default([]) @JsonKey(unknownEnumValue: SupportTopic.unknown) List<SupportTopic> allowedTopics,
  }) = _SupportThreadView;
  factory SupportThreadView.fromJson(Map<String, dynamic> json) => _$SupportThreadViewFromJson(json);
}

@freezed
abstract class AttachmentRef with _$AttachmentRef {
  const factory AttachmentRef({required String id, required String mime}) = _AttachmentRef;
  factory AttachmentRef.fromJson(Map<String, dynamic> json) => _$AttachmentRefFromJson(json);
}

@freezed
abstract class SupportMessage with _$SupportMessage {
  const factory SupportMessage({
    required String id,
    @JsonKey(unknownEnumValue: SenderType.unknown) required SenderType senderType,
    required String body,
    @JsonKey(unknownEnumValue: SupportTopic.unknown) SupportTopic? topic,
    String? applicantId,
    AttachmentRef? attachment,
    required String createdAt,
    String? readByUserAt,
  }) = _SupportMessage;
  factory SupportMessage.fromJson(Map<String, dynamic> json) => _$SupportMessageFromJson(json);
}

@freezed
abstract class SupportMessageList with _$SupportMessageList {
  const factory SupportMessageList({@Default([]) List<SupportMessage> items, String? nextCursor}) = _SupportMessageList;
  factory SupportMessageList.fromJson(Map<String, dynamic> json) => _$SupportMessageListFromJson(json);
}
