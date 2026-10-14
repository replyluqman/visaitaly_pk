import 'dart:async';

import 'package:dio/dio.dart';

import '../auth/auth_gateway.dart';
import '../storage/device_id_store.dart';
import 'api_error.dart';

/// Request options flags (kept in `RequestOptions.extra`).
abstract final class Extra {
  /// Skip the Authorization header (public endpoints).
  static const noAuth = 'noAuth';

  /// Skip X-Device-Id (POST /v1/auth/session carries deviceId in its body).
  static const noDevice = 'noDevice';

  /// Safe to retry on network error / 5xx (GET is implicitly idempotent).
  static const idempotent = 'idempotent';
  static const forceRefresh = 'forceRefresh';
  static const authRetried = 'authRetried';
  static const attempt = 'attempt';
}

/// 1. Attach the Firebase ID token. Firebase refreshes it when near expiry; a retry after UNAUTHENTICATED forces it.
class AuthInterceptor extends Interceptor {
  AuthInterceptor(this._auth);
  final AuthGateway _auth;

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    if (options.extra[Extra.noAuth] != true) {
      final token = await _auth.idToken(forceRefresh: options.extra[Extra.forceRefresh] == true);
      if (token != null) options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }
}

/// 2. Attach X-Device-Id.
class DeviceInterceptor extends Interceptor {
  DeviceInterceptor(this._device);
  final DeviceIdStore _device;

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    if (options.extra[Extra.noDevice] != true) {
      options.headers['X-Device-Id'] = await _device.getOrCreate();
    }
    handler.next(options);
  }
}

typedef Sleep = Future<void> Function(Duration d);

/// 3. Retry idempotent requests on network errors and 5xx — at most [maxRetries], with backoff. Never 4xx.
class RetryInterceptor extends Interceptor {
  RetryInterceptor(this._dio, {this.maxRetries = 2, Sleep? sleep, this.baseDelay = const Duration(milliseconds: 400)})
      : _sleep = sleep ?? Future.delayed;
  final Dio _dio;
  final int maxRetries;
  final Duration baseDelay;
  final Sleep _sleep;

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final o = err.requestOptions;
    final attempt = (o.extra[Extra.attempt] as int?) ?? 0;
    final idempotent = o.method.toUpperCase() == 'GET' || o.extra[Extra.idempotent] == true;
    final status = err.response?.statusCode;
    final transient = err.response == null
        ? (err.type != DioExceptionType.cancel && err.type != DioExceptionType.badCertificate)
        : status != null && status >= 500;
    if (!idempotent || !transient || attempt >= maxRetries) return handler.next(err);

    await _sleep(baseDelay * (1 << attempt));
    o.extra[Extra.attempt] = attempt + 1;
    try {
      handler.resolve(await _dio.fetch<dynamic>(o));
    } on DioException catch (e) {
      handler.reject(e);
    }
  }
}

typedef SessionTerminator = void Function(String code);

/// 4. Map every failure to [ApiError]; handle the session-terminal codes.
///
/// UNAUTHENTICATED: force-refresh the token and retry ONCE; only a second failure ends the session. The server
/// returns the same code when it cannot fetch Google's keys, so without the retry a Google/KV blip would sign
/// every user out. The other terminal codes end the session immediately.
class ErrorInterceptor extends Interceptor {
  ErrorInterceptor(this._dio, this._terminate);
  final Dio _dio;
  final SessionTerminator _terminate;

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    if (err.error is ApiError) return handler.next(err); // already mapped by a nested attempt
    final api = ApiError.fromDio(err);

    if (api.code == ApiCodes.unauthenticated && err.requestOptions.extra[Extra.authRetried] != true) {
      final o = err.requestOptions;
      o.extra[Extra.authRetried] = true;
      o.extra[Extra.forceRefresh] = true;
      try {
        return handler.resolve(await _dio.fetch<dynamic>(o));
      } on DioException catch (e) {
        return handler.reject(e); // the nested pass mapped it (and ended the session if it failed again)
      }
    }

    if (api.code == ApiCodes.unauthenticated || api.isTerminal) _terminate(api.code);
    handler.reject(DioException(
      requestOptions: err.requestOptions,
      response: err.response,
      type: err.type,
      error: api,
    ));
  }
}
