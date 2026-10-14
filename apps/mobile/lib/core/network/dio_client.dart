import 'package:dio/dio.dart';

import '../auth/auth_gateway.dart';
import '../config/app_config.dart';
import '../storage/device_id_store.dart';
import 'api_error.dart';
import 'interceptors.dart';

/// One Dio for the app. Interceptor order matters: auth → device → retry → error mapping.
Dio createDio({
  required AppConfig config,
  required AuthGateway auth,
  required DeviceIdStore device,
  required SessionTerminator onTerminal,
  HttpClientAdapter? adapter,
  Sleep? sleep,
}) {
  final dio = Dio(BaseOptions(
    baseUrl: config.apiBaseUrl,
    connectTimeout: config.requestTimeout,
    receiveTimeout: config.requestTimeout,
    sendTimeout: config.requestTimeout,
    contentType: Headers.jsonContentType,
    responseType: ResponseType.json,
    headers: {'Accept': 'application/json'},
  ));
  if (adapter != null) dio.httpClientAdapter = adapter;
  dio.interceptors.addAll([
    AuthInterceptor(auth),
    DeviceInterceptor(device),
    RetryInterceptor(dio, maxRetries: config.maxRetries, sleep: sleep),
    ErrorInterceptor(dio, onTerminal),
  ]);
  return dio;
}

/// Runs a request and unwraps failures to [ApiError]. Repositories use this so screens and controllers only
/// ever see ApiError, never DioException.
Future<T> apiCall<T>(Future<Response<dynamic>> Function() request, T Function(Object? json) parse) async {
  try {
    final res = await request();
    return parse(res.data);
  } on DioException catch (e) {
    final err = e.error;
    throw err is ApiError ? err : ApiError.fromDio(e);
  }
}
