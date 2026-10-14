import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/config/app_config.dart';
import 'package:visaitaly_pk/core/network/api_error.dart';
import 'package:visaitaly_pk/core/network/dio_client.dart';
import 'package:visaitaly_pk/core/network/interceptors.dart';

import '../helpers/fakes.dart';

const _cfg = AppConfig(flavor: Flavor.dev, apiBaseUrl: 'http://api.test');

({Dio dio, FakeAuthGateway auth, ScriptedAdapter adapter, List<String> terminated, List<Duration> sleeps}) make(
  Responder responder, {
  AuthUser? user = const AuthUser(uid: 'u1'),
}) {
  final auth = FakeAuthGateway(user: user);
  final adapter = ScriptedAdapter(responder);
  final terminated = <String>[];
  final sleeps = <Duration>[];
  final dio = createDio(
    config: _cfg,
    auth: auth,
    device: FakeDeviceIdStore(),
    onTerminal: terminated.add,
    adapter: adapter,
    sleep: (d) async => sleeps.add(d),
  );
  return (dio: dio, auth: auth, adapter: adapter, terminated: terminated, sleeps: sleeps);
}

Future<ApiError> failure(Future<Object?> f) async {
  try {
    await f;
  } on DioException catch (e) {
    return e.error! as ApiError;
  }
  fail('expected a failure');
}

void main() {
  group('headers', () {
    test('attaches the bearer token and the device id', () async {
      final t = make((_) => reply(200, {'ok': true}));
      await t.dio.get<dynamic>('/v1/me');
      final h = t.adapter.requests.single.headers;
      expect(h['Authorization'], 'Bearer tok-1');
      expect(h['X-Device-Id'], '11111111-1111-4111-8111-111111111111');
    });

    test('noAuth / noDevice flags skip the headers', () async {
      final t = make((_) => reply(200, {}));
      await t.dio.post<dynamic>('/v1/auth/session', options: Options(extra: {Extra.noDevice: true}));
      expect(t.adapter.requests.single.headers.containsKey('X-Device-Id'), isFalse);
      await t.dio.get<dynamic>('/health', options: Options(extra: {Extra.noAuth: true}));
      expect(t.adapter.requests.last.headers.containsKey('Authorization'), isFalse);
    });
  });

  group('error mapping', () {
    test('maps the shared body: code, message, details, requestId, status', () async {
      final t = make((_) => reply(422, errorBody('VALIDATION_FAILED', details: {'dateOfBirth': ['Required.']})));
      final e = await failure(t.dio.get<dynamic>('/v1/x'));
      expect(e.code, 'VALIDATION_FAILED');
      expect(e.status, 422);
      expect(e.requestId, 'req-1');
      expect(e.details['dateOfBirth'], ['Required.']);
      expect(t.terminated, isEmpty);
    });

    test('an unknown server code is treated as INTERNAL, never crashes', () async {
      final t = make((_) => reply(418, errorBody('A_NEW_CODE')));
      expect((await failure(t.dio.get<dynamic>('/v1/x'))).code, ApiCodes.internal);
    });

    test('a non-contract body (HTML from a proxy) is INTERNAL with the request id header', () async {
      final t = make((_) => reply(502, '<html>bad gateway</html>', {'x-request-id': 'abc'}));
      final e = await failure(t.dio.post<dynamic>('/v1/x'));
      expect([e.code, e.requestId], [ApiCodes.internal, 'abc']);
    });

    test('an error body delivered as a plain string (signed-URL transfers) is still decoded', () async {
      final t = make((_) => reply(422, errorBody('UPLOAD_REJECTED')));
      final e = await failure(t.dio.get<dynamic>('/v1/x', options: Options(responseType: ResponseType.plain)));
      expect(e.code, 'UPLOAD_REJECTED');
    });

    test('no response at all is NETWORK', () async {
      final t = make((_) => reply(0));
      expect((await failure(t.dio.post<dynamic>('/v1/x'))).code, ApiCodes.network);
    });
  });

  group('UNAUTHENTICATED: refresh once, retry once, then sign out', () {
    test('a stale token is refreshed and the request succeeds — no sign-out', () async {
      var calls = 0;
      final t = make((_) => ++calls == 1 ? reply(401, errorBody('UNAUTHENTICATED')) : reply(200, {'ok': true}));
      final res = await t.dio.get<dynamic>('/v1/me');
      expect(res.statusCode, 200);
      expect(t.adapter.requests, hasLength(2));
      expect(t.adapter.requests.last.headers['Authorization'], 'Bearer tok-2'); // the force-refreshed token
      expect(t.auth.tokenRequests, [false, true]);
      expect(t.terminated, isEmpty);
    });

    test('a second UNAUTHENTICATED ends the session exactly once', () async {
      final t = make((_) => reply(401, errorBody('UNAUTHENTICATED')));
      final e = await failure(t.dio.get<dynamic>('/v1/me'));
      expect(e.code, ApiCodes.unauthenticated);
      expect(t.adapter.requests, hasLength(2)); // one retry, not a loop
      expect(t.terminated, [ApiCodes.unauthenticated]);
    });
  });

  group('terminal codes', () {
    for (final code in ['DEVICE_UNKNOWN', 'DEVICE_EVICTED', 'DEVICE_SIGNED_OUT', 'USER_DELETED']) {
      test('$code ends the session immediately, with no retry', () async {
        final t = make((_) => reply(code == 'USER_DELETED' ? 403 : 401, errorBody(code)));
        final e = await failure(t.dio.get<dynamic>('/v1/me'));
        expect(e.code, code);
        expect(t.adapter.requests, hasLength(1));
        expect(t.terminated, [code]);
      });
    }

    test('non-terminal client errors do not end the session', () async {
      for (final c in ['APPLICANT_READ_ONLY', 'LEGAL_ACCEPTANCE_REQUIRED', 'NOT_FOUND', 'CONFLICT']) {
        final t = make((_) => reply(403, errorBody(c)));
        await failure(t.dio.get<dynamic>('/v1/x'));
        expect(t.terminated, isEmpty, reason: c);
      }
    });
  });

  group('retries', () {
    test('GET retries network errors with backoff, max 2, then fails', () async {
      final t = make((_) => reply(0));
      final e = await failure(t.dio.get<dynamic>('/v1/me'));
      expect(e.code, ApiCodes.network);
      expect(t.adapter.requests, hasLength(3)); // 1 + 2 retries
      expect(t.sleeps, [const Duration(milliseconds: 400), const Duration(milliseconds: 800)]);
    });

    test('GET retries a 5xx and recovers', () async {
      var n = 0;
      final t = make((_) => ++n < 3 ? reply(503, errorBody('INTERNAL')) : reply(200, {'ok': 1}));
      expect((await t.dio.get<dynamic>('/v1/me')).statusCode, 200);
      expect(t.adapter.requests, hasLength(3));
    });

    test('POST is never retried unless flagged idempotent (no duplicate applicants)', () async {
      final t = make((_) => reply(0));
      await failure(t.dio.post<dynamic>('/v1/applicants'));
      expect(t.adapter.requests, hasLength(1));
    });

    test('an idempotent POST (session registration) is retried', () async {
      final t = make((_) => reply(0));
      await failure(t.dio.post<dynamic>('/v1/auth/session', options: Options(extra: {Extra.idempotent: true})));
      expect(t.adapter.requests, hasLength(3));
    });

    test('4xx is never retried', () async {
      final t = make((_) => reply(404, errorBody('NOT_FOUND')));
      await failure(t.dio.get<dynamic>('/v1/x'));
      expect(t.adapter.requests, hasLength(1));
    });
  });

  test('apiCall unwraps DioException to ApiError', () async {
    final t = make((_) => reply(409, errorBody('APPLICANT_LIMIT_REACHED')));
    await expectLater(
      apiCall(() => t.dio.post<dynamic>('/v1/applicants'), (j) => j),
      throwsA(isA<ApiError>().having((e) => e.code, 'code', ApiCodes.applicantLimitReached)),
    );
  });

  test('AppConfig requires API_BASE_URL outside dev', () {
    expect(() => AppConfig.fromEnvironment(Flavor.prod), throwsStateError);
    expect(AppConfig.fromEnvironment(Flavor.dev).apiBaseUrl, 'http://10.0.2.2:8787');
  });
}
