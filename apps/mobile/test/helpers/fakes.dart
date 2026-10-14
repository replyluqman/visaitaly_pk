import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/storage/device_id_store.dart';

/// Real server responses captured by apps/api/test/mobile-fixtures.test.ts.
Map<String, dynamic> fixture(String name) =>
    jsonDecode(File('test/fixtures/$name.json').readAsStringSync()) as Map<String, dynamic>;

class FakeAuthGateway implements AuthGateway {
  FakeAuthGateway({this._user, this.token = 'tok-1'});
  AuthUser? _user;
  String? token;
  final _ctrl = StreamController<AuthUser?>.broadcast(sync: true);
  final List<bool> tokenRequests = []; // forceRefresh flag per call
  int signOutCalls = 0;
  AuthFailure? failNext;

  /// Tokens handed out when forceRefresh is true (simulates Firebase minting a fresh one).
  String refreshedToken = 'tok-2';

  @override
  Stream<AuthUser?> authStateChanges() async* {
    yield _user;
    yield* _ctrl.stream;
  }

  void emit(AuthUser? u) {
    _user = u;
    _ctrl.add(u);
  }

  @override
  Future<String?> idToken({bool forceRefresh = false}) async {
    tokenRequests.add(forceRefresh);
    if (_user == null) return null;
    return forceRefresh ? refreshedToken : token;
  }

  @override
  Future<void> signInWithEmail(String email, String password) async {
    if (failNext != null) throw failNext!;
    emit(AuthUser(uid: 'u1', email: email));
  }

  @override
  Future<void> signUpWithEmail(String email, String password) async {
    if (failNext != null) throw failNext!;
    emit(AuthUser(uid: 'u1', email: email));
  }

  @override
  Future<void> signOut() async {
    signOutCalls++;
    emit(null);
  }
}

class FakeDeviceIdStore implements DeviceIdStore {
  @override
  Future<String> getOrCreate() async => '11111111-1111-4111-8111-111111111111';
}

typedef Responder = ({int status, Object? body, Map<String, String>? headers}) Function(RequestOptions o);

({int status, Object? body, Map<String, String>? headers}) reply(int status, [Object? body, Map<String, String>? headers]) =>
    (status: status, body: body, headers: headers);

/// An HttpClientAdapter that records every request and answers from a function — no sockets.
class ScriptedAdapter implements HttpClientAdapter {
  ScriptedAdapter(this.responder);
  Responder responder;
  final List<RequestOptions> requests = [];

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    requests.add(options);
    final r = responder(options);
    if (r.status == 0) {
      throw DioException.connectionError(requestOptions: options, reason: 'offline');
    }
    return ResponseBody.fromString(
      jsonEncode(r.body),
      r.status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
        for (final e in (r.headers ?? const <String, String>{}).entries) e.key: [e.value],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

Map<String, dynamic> errorBody(String code, {String message = 'm', Map<String, List<String>>? details}) => {
      'error': {'code': code, 'message': message, 'requestId': 'req-1', 'details': ?details},
    };
