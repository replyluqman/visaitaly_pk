import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/models/enums.dart';
import 'package:visaitaly_pk/core/network/api_error.dart';
import 'package:visaitaly_pk/core/providers.dart';
import 'package:visaitaly_pk/features/checklist/data/checklist_repository.dart';

import '../helpers/fakes.dart';
import '../helpers/harness.dart';

/// Records the body bytes of requests too (streams), so uploads can be asserted byte-for-byte.
class _Recording extends ScriptedAdapter {
  _Recording(super.responder);
  final List<Uint8List> bodies = [];

  @override
  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {
    final chunks = <int>[];
    if (requestStream != null) {
      await for (final c in requestStream) {
        chunks.addAll(c);
      }
    }
    bodies.add(Uint8List.fromList(chunks));
    return super.fetch(options, requestStream, cancelFuture);
  }
}

void main() {
  late Harness h;
  late dynamic c;
  late _Recording adapter;

  void setUpWith(Responder r) {
    adapter = _Recording(r);
    h = harnessWith(adapter, user: const AuthUser(uid: 'u1'));
    c = h.container();
  }

  tearDown(() => c.dispose());

  group('checklist', () {
    test('list sends filters as wire values and omits unset ones', () async {
      setUpWith((_) => reply(200, fixture('checklist_premium')));
      await (c.read(checklistRepositoryProvider) as ChecklistRepository).list(
        'app-1',
        filter: const ChecklistFilter(status: ItemStatus.issueFound, blocking: true),
        cursor: 'abc',
      );
      final q = adapter.requests.single.queryParameters;
      expect(q, {'limit': 20, 'locale': 'en', 'cursor': 'abc', 'status': 'issue_found', 'blocking': true});
      expect(q.containsKey('translation'), isFalse);
    });

    test('setStatus patches the wire value; premium-required surfaces as a code', () async {
      setUpWith((o) => o.method == 'PATCH' ? reply(402, errorBody('PREMIUM_REQUIRED')) : reply(200, {}));
      await expectLater(
        (c.read(checklistRepositoryProvider) as ChecklistRepository).setStatus('i1', ItemStatus.inProgress),
        throwsA(isA<ApiError>().having((e) => e.code, 'code', ApiCodes.premiumRequired)),
      );
      expect((adapter.requests.single.data as Map)['status'], 'in_progress');
    });
  });

  group('documents', () {
    test('upload = reserve → PUT exact bytes with required headers and NO token → complete', () async {
      final bytes = Uint8List.fromList(List.generate(100, (i) => i));
      setUpWith((o) {
        if (o.path == '/v1/documents/upload-url') return reply(200, fixture('document_upload_url'));
        if (o.method == 'PUT') return reply(204, null);
        return reply(200, fixture('document_complete'));
      });
      final doc = await c.read(documentsRepositoryProvider).upload(
            applicantId: 'app-1',
            bytes: bytes,
            mime: 'image/png',
            checklistItemId: 'item-1',
          );
      expect(doc.id, isNotEmpty);

      final reserve = adapter.requests[0];
      expect(reserve.data, containsPair('sizeBytes', 100));
      expect((reserve.data as Map)['sha256'], matches(RegExp(r'^[a-f0-9]{64}$')));
      expect((reserve.data as Map)['checklistItemId'], 'item-1');

      final put = adapter.requests[1];
      expect(put.method, 'PUT');
      expect(put.uri.toString(), contains('/content?exp='));
      expect(put.headers.containsKey('Authorization'), isFalse, reason: 'the Firebase token must never reach a signed URL');
      expect(put.headers.containsKey('X-Device-Id'), isFalse);
      expect(put.headers['content-type'] ?? put.headers['Content-Type'], 'image/png');
      expect(put.headers['content-length'] ?? put.headers['Content-Length'], 100);
      expect(adapter.bodies[1], bytes);

      expect(adapter.requests[2].path, endsWith('/complete'));
    });

    test('a failed PUT is not retried and complete is never called (nothing half-uploaded is exposed)', () async {
      setUpWith((o) {
        if (o.path == '/v1/documents/upload-url') return reply(200, fixture('document_upload_url'));
        return reply(422, errorBody('UPLOAD_REJECTED'));
      });
      await expectLater(
        c.read(documentsRepositoryProvider).upload(applicantId: 'a', bytes: Uint8List(10), mime: 'image/png'),
        throwsA(isA<ApiError>().having((e) => e.code, 'code', ApiCodes.uploadRejected)),
      );
      expect(adapter.requests.where((r) => r.path.endsWith('/complete')), isEmpty);
      expect(adapter.requests.where((r) => r.method == 'PUT'), hasLength(1));
    });
  });

  group('public endpoints carry no credentials', () {
    test('verification summary and Quick Check send neither token nor device id', () async {
      setUpWith((o) => o.path.contains('verification') ? reply(200, fixture('verification_summary')) : reply(200, fixture('eligibility_result')));
      await c.read(publicRepositoryProvider).verificationSummary();
      await c.read(publicRepositoryProvider).submitEligibility(version: 1, answers: {'who': 'spouse'});
      for (final r in adapter.requests) {
        expect(r.headers.containsKey('Authorization'), isFalse, reason: r.path);
        expect(r.headers.containsKey('X-Device-Id'), isFalse, reason: r.path);
      }
      expect(adapter.requests.last.data, {'version': 1, 'answers': {'who': 'spouse'}});
    });
  });

  group('support and notifications', () {
    test('send is not retried; topic goes as the wire value', () async {
      setUpWith((_) => reply(0));
      await expectLater(
        c.read(supportRepositoryProvider).send(body: 'hi', topic: SupportTopic.appProblem),
        throwsA(isA<ApiError>()),
      );
      expect(adapter.requests, hasLength(1));
      expect((adapter.requests.single.data as Map)['topic'], 'app_problem');
    });

    test('read-all without a tab sends an empty JSON object', () async {
      setUpWith((_) => reply(204, null));
      await c.read(notificationsRepositoryProvider).readAll();
      expect(adapter.requests.single.data, <String, Object?>{});
      await c.read(notificationsRepositoryProvider).readAll(tab: NotificationTab.update);
      expect(adapter.requests.last.data, {'tab': 'update'});
    });

    test('preferences write only the keys that changed', () async {
      setUpWith((_) => reply(200, fixture('notification_preferences')));
      await c.read(notificationsRepositoryProvider).setPush(update: false);
      expect(jsonEncode(adapter.requests.single.data), '{"push":{"update":false}}');
    });
  });

  group('account', () {
    test('delete sends {confirm:true}; a stale sign-in surfaces REAUTH_REQUIRED', () async {
      setUpWith((_) => reply(401, errorBody('REAUTH_REQUIRED')));
      await expectLater(
        c.read(accountRepositoryProvider).deleteAccount(),
        throwsA(isA<ApiError>().having((e) => e.code, 'code', ApiCodes.reauthRequired)),
      );
      expect(adapter.requests.single.data, {'confirm': true});
      expect(h.auth.signOutCalls, 0, reason: 'REAUTH_REQUIRED is not session-terminal');
    });
  });
}
