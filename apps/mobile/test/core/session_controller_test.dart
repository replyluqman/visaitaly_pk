import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/providers.dart';
import 'package:visaitaly_pk/core/session/session_state.dart';

import '../helpers/fakes.dart';
import '../helpers/harness.dart';

const _user = AuthUser(uid: 'u1', email: 'a@b.co');

/// Server stub: /v1/me and /v1/auth/session answer from fixtures; anything else 404.
({int status, Object? body, Map<String, String>? headers}) server(RequestOptions o, {String me = 'me_complete'}) {
  if (o.path == '/v1/auth/session') return reply(201, fixture('auth_session_new_user'));
  if (o.path == '/v1/me') return reply(200, fixture(me));
  return reply(404, errorBody('NOT_FOUND'));
}

Future<void> settle() => Future<void>.delayed(const Duration(milliseconds: 150));

void main() {
  test('cold start with a restored Firebase user loads GET /v1/me (not register)', () async {
    final h = harness((o) => server(o), user: _user);
    final c = h.container();
    addTearDown(c.dispose);
    expect(c.read(sessionControllerProvider), isA<SessionLoading>());
    await settle();
    expect(c.read(sessionControllerProvider), isA<SessionReady>());
    expect(h.requestsTo('/v1/me'), hasLength(1));
    expect(h.requestsTo('/v1/auth/session'), isEmpty);
  });

  test('no Firebase user → signed out, no network call', () async {
    final h = harness((o) => server(o));
    final c = h.container();
    addTearDown(c.dispose);
    c.read(sessionControllerProvider);
    await settle();
    expect(c.read(sessionControllerProvider), isA<SessionSignedOut>());
    expect(h.adapter.requests, isEmpty);
  });

  test('an interactive sign-in registers the device (POST /v1/auth/session) with the id in the body', () async {
    final h = harness((o) => server(o, me: 'me_disclaimer_pending'));
    final c = h.container();
    addTearDown(c.dispose);
    c.read(sessionControllerProvider);
    await settle();
    h.auth.emit(_user); // the user signs in
    await settle();
    expect(c.read(sessionControllerProvider), isA<SessionReady>());
    final reg = h.requestsTo('/v1/auth/session').single;
    expect(reg.data, containsPair('deviceId', '11111111-1111-4111-8111-111111111111'));
    expect(reg.data, containsPair('platform', 'android'));
    expect(reg.data, containsPair('appVersion', '1.0.0'));
    expect(reg.headers.containsKey('X-Device-Id'), isFalse); // session registration carries it in the body
    expect(h.requestsTo('/v1/me'), isEmpty);
  });

  test('sign-out clears state; a later sign-in registers again', () async {
    final h = harness((o) => server(o), user: _user);
    final c = h.container();
    addTearDown(c.dispose);
    c.read(sessionControllerProvider);
    await settle();
    await c.read(sessionControllerProvider.notifier).signOut();
    await settle();
    expect(c.read(sessionControllerProvider), isA<SessionSignedOut>());
    h.auth.emit(_user);
    await settle();
    expect(h.requestsTo('/v1/auth/session'), hasLength(1));
  });

  group('terminal codes', () {
    for (final entry in {
      'DEVICE_EVICTED': (401, SignOutNotice.deviceEvicted),
      'DEVICE_SIGNED_OUT': (401, SignOutNotice.deviceSignedOut),
      'DEVICE_UNKNOWN': (401, SignOutNotice.deviceUnknown),
      'USER_DELETED': (403, SignOutNotice.accountDeleted),
    }.entries) {
      test('${entry.key} on cold start → signed out with the matching notice', () async {
        final h = harness((o) => reply(entry.value.$1, errorBody(entry.key)), user: _user);
        final c = h.container();
        addTearDown(c.dispose);
        c.read(sessionControllerProvider);
        await settle();
        final s = c.read(sessionControllerProvider);
        expect(s, isA<SessionSignedOut>());
        expect((s as SessionSignedOut).notice, entry.value.$2);
        expect(h.auth.signOutCalls, 1);
      });
    }

    test('a burst of parallel terminal failures signs out ONCE (single-flight)', () async {
      var meCalls = 0;
      final h = harness((o) => o.path == '/v1/me' && meCalls++ == 0 ? reply(200, fixture('me_complete')) : reply(401, errorBody('DEVICE_EVICTED')), user: _user);
      final c = h.container();
      addTearDown(c.dispose);
      c.read(sessionControllerProvider);
      await settle();
      final dio = c.read(dioProvider);
      await Future.wait([for (var i = 0; i < 5; i++) dio.get<dynamic>('/v1/devices').then((_) {}, onError: (_) {})]);
      await settle();
      expect(h.auth.signOutCalls, 1);
    });
  });

  test('a transient failure on cold start shows SessionFailed; retry recovers', () async {
    var up = false;
    final h = harness((o) => up ? server(o) : reply(0), user: _user);
    final c = h.container();
    addTearDown(c.dispose);
    c.read(sessionControllerProvider);
    await settle();
    expect(c.read(sessionControllerProvider), isA<SessionFailed>());
    up = true;
    await c.read(sessionControllerProvider.notifier).retry();
    expect(c.read(sessionControllerProvider), isA<SessionReady>());
  });

  test('refresh() keeps the last good snapshot when the network drops', () async {
    var up = true;
    final h = harness((o) => up ? server(o) : reply(0), user: _user);
    final c = h.container();
    addTearDown(c.dispose);
    c.read(sessionControllerProvider);
    await settle();
    up = false;
    await c.read(sessionControllerProvider.notifier).refresh();
    expect(c.read(sessionControllerProvider), isA<SessionReady>());
  });

  test('resume refreshes only when the snapshot is older than the configured window', () async {
    final h = harness((o) => server(o), user: _user);
    final c = h.container();
    addTearDown(c.dispose);
    c.read(sessionControllerProvider);
    await settle();
    final ctl = c.read(sessionControllerProvider.notifier);
    h.clock.now = h.clock.now.add(const Duration(minutes: 29));
    await ctl.refreshIfStale();
    expect(h.requestsTo('/v1/me'), hasLength(1)); // still fresh
    h.clock.now = h.clock.now.add(const Duration(minutes: 2));
    await ctl.refreshIfStale();
    expect(h.requestsTo('/v1/me'), hasLength(2));
  });
}
