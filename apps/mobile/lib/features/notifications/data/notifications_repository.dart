import 'package:dio/dio.dart';

import '../../../core/models/enums.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors.dart';
import 'dto/notification_dto.dart';

class NotificationsRepository {
  NotificationsRepository(this._dio);
  final Dio _dio;

  Future<NotificationList> list(NotificationTab tab, {String? cursor, int limit = 20}) => apiCall(
        () => _dio.get<dynamic>('/v1/notifications', queryParameters: {'tab': wire(tab), 'limit': limit, 'cursor': ?cursor}),
        (j) => NotificationList.fromJson(j! as Map<String, dynamic>),
      );

  /// One grouped, indexed count — cheap enough for the bell on every top-level screen.
  Future<UnreadCount> unreadCount() => apiCall(
        () => _dio.get<dynamic>('/v1/notifications/unread-count'),
        (j) => UnreadCount.fromJson(j! as Map<String, dynamic>),
      );

  Future<void> markRead(String id) => apiCall(
        () => _dio.post<dynamic>('/v1/notifications/$id/read', options: Options(extra: {Extra.idempotent: true})),
        (_) {},
      );

  Future<void> readAll({NotificationTab? tab}) => apiCall(
        () => _dio.post<dynamic>(
          '/v1/notifications/read-all',
          data: tab == null ? <String, Object?>{} : {'tab': wire(tab)},
          options: Options(extra: {Extra.idempotent: true}),
        ),
        (_) {},
      );

  Future<NotificationPreferences> preferences() => apiCall(
        () => _dio.get<dynamic>('/v1/notification-preferences'),
        (j) => NotificationPreferences.fromJson(j! as Map<String, dynamic>),
      );

  Future<NotificationPreferences> setPush({bool? reminder, bool? update, bool? activity}) => apiCall(
        () => _dio.put<dynamic>(
          '/v1/notification-preferences',
          data: {
            'push': {'reminder': ?reminder, 'update': ?update, 'activity': ?activity},
          },
          options: Options(extra: {Extra.idempotent: true}),
        ),
        (j) => NotificationPreferences.fromJson(j! as Map<String, dynamic>),
      );
}
