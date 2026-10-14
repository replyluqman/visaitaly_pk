import 'package:freezed_annotation/freezed_annotation.dart';

import '../../../../core/models/enums.dart';

part 'notification_dto.freezed.dart';
part 'notification_dto.g.dart';

@freezed
abstract class AppNotification with _$AppNotification {
  const factory AppNotification({
    required String id,
    @JsonKey(unknownEnumValue: NotificationTab.unknown) required NotificationTab tab,
    required String type,
    required String title,
    required String body,

    /// App-relative path, mandatory on every notification.
    required String deepLink,
    String? applicantId,
    required String createdAt,
    String? readAt,
  }) = _AppNotification;
  factory AppNotification.fromJson(Map<String, dynamic> json) => _$AppNotificationFromJson(json);
}

@freezed
abstract class NotificationList with _$NotificationList {
  const factory NotificationList({@Default([]) List<AppNotification> items, String? nextCursor}) = _NotificationList;
  factory NotificationList.fromJson(Map<String, dynamic> json) => _$NotificationListFromJson(json);
}

@freezed
abstract class ByTab with _$ByTab {
  const factory ByTab({@Default(0) int reminder, @Default(0) int update, @Default(0) int activity}) = _ByTab;
  factory ByTab.fromJson(Map<String, dynamic> json) => _$ByTabFromJson(json);
}

@freezed
abstract class UnreadCount with _$UnreadCount {
  const factory UnreadCount({@Default(0) int total, @Default(ByTab()) ByTab byTab}) = _UnreadCount;
  factory UnreadCount.fromJson(Map<String, dynamic> json) => _$UnreadCountFromJson(json);
}

@freezed
abstract class PushPrefs with _$PushPrefs {
  const factory PushPrefs({@Default(true) bool reminder, @Default(true) bool update, @Default(true) bool activity}) = _PushPrefs;
  factory PushPrefs.fromJson(Map<String, dynamic> json) => _$PushPrefsFromJson(json);
}

@freezed
abstract class NotificationPreferences with _$NotificationPreferences {
  const factory NotificationPreferences({@Default(PushPrefs()) PushPrefs push}) = _NotificationPreferences;
  factory NotificationPreferences.fromJson(Map<String, dynamic> json) => _$NotificationPreferencesFromJson(json);
}
