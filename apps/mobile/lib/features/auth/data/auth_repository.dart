import 'package:dio/dio.dart';

import '../../../core/app_info.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors.dart';
import 'dto/me_dto.dart';

class AuthRepository {
  AuthRepository(this._dio);
  final Dio _dio;

  /// POST /v1/auth/session — after EVERY Firebase sign-in. Idempotent, so it is retried freely.
  /// Returns the same snapshot as /v1/me plus `session` (devices evicted by this login).
  Future<({MeResponse me, SessionInfoDto session})> registerSession({
    required String deviceId,
    required AppInfo app,
  }) =>
      apiCall(
        () => _dio.post<dynamic>(
          '/v1/auth/session',
          data: {
            'deviceId': deviceId,
            'platform': app.platform,
            'appVersion': app.appVersion,
            'osVersion': ?app.osVersion,
            'model': ?app.model,
          },
          options: Options(extra: {Extra.noDevice: true, Extra.idempotent: true}),
        ),
        (json) {
          final map = json! as Map<String, dynamic>;
          return (
            me: MeResponse.fromJson(map),
            session: SessionInfoDto.fromJson((map['session'] as Map<String, dynamic>?) ?? const {}),
          );
        },
      );

  /// GET /v1/me — the launch snapshot. Routing is decided from this, never from local flags.
  Future<MeResponse> getMe() =>
      apiCall(() => _dio.get<dynamic>('/v1/me'), (json) => MeResponse.fromJson(json! as Map<String, dynamic>));
}
