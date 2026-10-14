import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/file_picker_gateway.dart';
import 'package:visaitaly_pk/core/design/perf_tier.dart';

import '../helpers/app_driver.dart';
import '../helpers/fakes.dart';

void main() {
  group('Support Thread (Screen 25)', () {
    testWidgets('empty thread: topic chips are the ones the server allows (free = pre-sales set) and a free-tier hint', (tester) async {
      final s = completeServer()
        ..stub('GET /v1/support/thread', fixture('support_thread_none'))
        ..stub('GET /v1/support/messages', {'items': [], 'nextCursor': null})
        ..stub('POST /v1/support/read', null, status: 204);
      final d = await pumpSignedIn(tester, s);
      await d.push('/support');
      expect(find.byKey(const Key('supportEmpty')), findsOneWidget);
      expect(find.byKey(const Key('topic_presales')), findsOneWidget);
      expect(find.byKey(const Key('topic_appProblem')), findsOneWidget);
      expect(find.byKey(const Key('topic_account')), findsOneWidget);
      expect(find.byKey(const Key('topic_payment')), findsNothing);
      expect(find.byKey(const Key('topicLocked')), findsOneWidget);
      expect(find.byKey(const Key('supportDisclaimer')), findsOneWidget);
    });

    testWidgets('opening the thread marks replies read', (tester) async {
      final s = completeServer()
        ..stub('GET /v1/support/thread', fixture('support_thread_replied'))
        ..stub('GET /v1/support/messages', fixture('support_messages'))
        ..stub('POST /v1/support/read', null, status: 204);
      final d = await pumpSignedIn(tester, s);
      await d.push('/support');
      expect(d.logs('POST', '/v1/support/read'), hasLength(1));
    });

    testWidgets('conversation shows both sides, newest at the bottom; sending needs a topic, then posts the wire value', (tester) async {
      final s = completeServer()
        ..stub('GET /v1/support/thread', fixture('support_thread_replied'))
        ..stub('GET /v1/support/messages', fixture('support_messages'))
        ..stub('POST /v1/support/read', null, status: 204)
        ..stub('POST /v1/support/messages', fixture('support_message_sent'), status: 201);
      final d = await pumpSignedIn(tester, s);
      await d.push('/support');
      expect(find.text('Premium includes your personalised checklist.'), findsOneWidget);
      expect(find.text('What does Premium include?'), findsOneWidget);
      // newest (admin reply) is lower on screen than the user's message
      expect(tester.getTopLeft(find.text('Premium includes your personalised checklist.')).dy,
          greaterThan(tester.getTopLeft(find.text('What does Premium include?')).dy));

      await tester.enterText(find.byKey(const Key('composer')), 'Thanks');
      await tester.pump();
      expect(tester.widget<IconButton>(find.byKey(const Key('send'))).onPressed, isNull, reason: 'no topic chosen yet');
      await d.tap(find.byKey(const Key('topic_appProblem')));
      await d.tap(find.byKey(const Key('send')));
      final sent = d.logs('POST', '/v1/support/messages').single.data as Map;
      expect(sent['topic'], 'app_problem');
      expect(sent['body'], 'Thanks');
    });

    testWidgets('awaiting support: the SLA deadline is shown WITH the working-hours statement', (tester) async {
      final s = completeServer()
        ..stub('GET /v1/support/thread', {
          'status': 'awaiting_support', 'tier': 'paid', 'slaDueAt': '2026-10-15T09:00:00Z', 'unreadCount': 0,
          'workingHoursText': 'Mon–Sat 9–6 PKT', 'allowedTopics': ['payment', 'presales'],
        })
        ..stub('GET /v1/support/messages', {'items': [], 'nextCursor': null})
        ..stub('POST /v1/support/read', null, status: 204);
      final d = await pumpSignedIn(tester, s);
      await d.push('/support');
      expect(find.byKey(const Key('slaDeadline')), findsOneWidget);
      expect(find.text('Working hours: Mon–Sat 9–6 PKT'), findsOneWidget);
      expect(find.byKey(const Key('topicLocked')), findsNothing, reason: 'paid accounts have all topics');
    });

    testWidgets('a topic the tier does not allow is refused by the server and explained', (tester) async {
      final s = completeServer()
        ..stub('GET /v1/support/thread', fixture('support_thread_none'))
        ..stub('GET /v1/support/messages', {'items': [], 'nextCursor': null})
        ..stub('POST /v1/support/read', null, status: 204)
        ..stub('POST /v1/support/messages', fixture('error_support_topic_not_allowed'), status: 403);
      final d = await pumpSignedIn(tester, s);
      await d.push('/support');
      await d.tap(find.byKey(const Key('topic_presales')));
      await tester.enterText(find.byKey(const Key('composer')), 'hello');
      await tester.pump();
      await d.tap(find.byKey(const Key('send')));
      expect(find.byType(SnackBar), findsOneWidget);
    });

    testWidgets('attaching an image uploads it first (signed URL, no token) and sends its id', (tester) async {
      final s = completeServer()
        ..stub('GET /v1/support/thread', fixture('support_thread_none'))
        ..stub('GET /v1/support/messages', {'items': [], 'nextCursor': null})
        ..stub('POST /v1/support/read', null, status: 204)
        ..stub('POST /v1/support/attachments/upload-url', fixture('support_attachment_upload'))
        ..stub('~PUT /v1/support/attachments/.+/content', null, status: 204)
        ..stub('POST /v1/support/messages', fixture('support_message_sent'), status: 201);
      final d = await pumpSignedIn(tester, s, pick: PickedFile(name: 'a.png', bytes: Uint8List(40), mime: 'image/png'));
      await d.push('/support');
      await d.tap(find.byKey(const Key('topic_presales')));
      await d.tap(find.byKey(const Key('attach')));
      expect(d.picker.lastImagesOnly, isTrue, reason: 'support attachments are images only');
      expect(find.byKey(const Key('attached')), findsOneWidget);
      await d.tap(find.byKey(const Key('send')));
      final order = d.server.log.map((r) => '${r.method} ${r.path.split('/').take(4).join('/')}').toList();
      final up = order.indexWhere((e) => e.startsWith('POST /v1/support/attachments'));
      final put = order.indexWhere((e) => e.startsWith('PUT /v1/support/attachments'));
      final send = order.indexWhere((e) => e == 'POST /v1/support/messages');
      expect(up, lessThan(put));
      expect(put, lessThan(send));
      expect((d.logs('POST', '/v1/support/messages').single.data as Map)['attachmentId'], fixture('support_attachment_upload')['id']);
      expect(d.h.adapter.requests.firstWhere((r) => r.method == 'PUT').headers.containsKey('Authorization'), isFalse);
    });

    testWidgets('a closed thread says sending reopens it', (tester) async {
      final s = completeServer()
        ..stub('GET /v1/support/thread', {'status': 'closed', 'tier': 'free', 'slaDueAt': null, 'unreadCount': 0, 'workingHoursText': null, 'allowedTopics': ['presales']})
        ..stub('GET /v1/support/messages', {'items': [], 'nextCursor': null})
        ..stub('POST /v1/support/read', null, status: 204);
      final d = await pumpSignedIn(tester, s);
      await d.push('/support');
      expect(find.byKey(const Key('closedNote')), findsOneWidget);
    });

  });

  group('Account / Settings (Screen 29)', () {
    Future<Driver> open(WidgetTester tester, {Map<String, dynamic>? consents, Map<String, dynamic>? devices}) async {
      final s = completeServer();
      s
        ..stub('GET /v1/account/consents', consents ?? fixture('consents_saved'))
        ..stub('GET /v1/devices', devices ?? fixture('devices'))
        ..stub('GET /v1/notification-preferences', fixture('notification_preferences'))
        ..stub('GET /v1/legal/current', {
          'documents': [
            {'id': 'v1', 'docType': 'disclaimer', 'locale': 'en', 'version': '2.0', 'title': 'Disclaimer', 'isMandatory': true, 'publishedAt': null, 'accepted': true},
            {'id': 'v2', 'docType': 'privacy', 'locale': 'en', 'version': '3.1', 'title': 'Privacy Policy', 'isMandatory': true, 'publishedAt': null, 'accepted': true},
          ],
          'requiresAcceptance': false,
        })
        ..stub('PUT /v1/account/consents', fixture('consents_saved'))
        ..stub('PUT /v1/notification-preferences', fixture('notification_preferences'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/account');
      return d;
    }

    testWidgets('consents: each switch writes only its own purpose, stamped with the privacy policy version shown', (tester) async {
      final d = await open(tester);
      await d.tap(find.byKey(const Key('consentMarketing')));
      final put = d.logs('PUT', '/v1/account/consents').single.data as Map;
      expect(put, {'marketingPush': true, 'policyVersion': '3.1'});
    });

    testWidgets('push preferences write only the changed tab', (tester) async {
      final d = await open(tester);
      await d.tap(find.byKey(const Key('pushUpdate')));
      expect((d.logs('PUT', '/v1/notification-preferences').single.data as Map)['push'], {'update': false});
    });

    testWidgets('devices: this device is labelled, another can be signed out', (tester) async {
      final other = {
        'deviceId': '99999999-9999-4999-8999-999999999999', 'platform': 'android', 'model': 'Pixel 7', 'appVersion': '1.0.0',
        'lastLoginAt': '2026-10-13T10:00:00Z', 'lastSeenAt': '2026-10-13T10:00:00Z', 'isCurrent': false,
      };
      final cur = (fixture('devices')['devices'] as List).first as Map<String, dynamic>;
      final d = await open(tester, devices: {'devices': [cur, other]});
      d.server.stub('~DELETE /v1/devices/.+', null, status: 204);
      expect(find.text('This device'), findsOneWidget);
      expect(find.text('Up to 2 devices can be signed in at once.'), findsOneWidget);
      await d.tap(find.byKey(Key('signOutDevice_${other['deviceId']}')));
      expect(d.logs('DELETE', '/v1/devices/${other['deviceId']}'), hasLength(1));
    });

    testWidgets('legal documents list the accepted versions', (tester) async {
      final d = await open(tester);
      await tester.dragUntilVisible(find.byKey(const Key('legal_privacy')), find.byType(ListView).first, const Offset(0, -300));
      expect(find.text('v3.1 · Accepted'), findsOneWidget);
      expect(d.server.log, isNotEmpty);
    });

    testWidgets('"Reduce visual effects" forces the solid tier', (tester) async {
      final d = await open(tester);
      final c = ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
      await d.tap(find.byKey(const Key('reduceEffects')));
      expect(c.read(perfTierProvider), PerfTier.solid);
    });

    testWidgets('data export: request → status; ready shows a download that opens the signed URL', (tester) async {
      final d = await open(tester);
      d.server
        ..stub('POST /v1/account/data-export', fixture('data_export_requested'), status: 202)
        ..stub('~GET /v1/account/data-exports/.+', {
          'id': 'x', 'status': 'completed', 'requestedAt': '2026-10-14T00:00:00Z', 'completedAt': '2026-10-14T00:05:00Z',
          'expiresAt': '2026-10-21T00:05:00Z', 'downloadUrl': 'https://api.test/v1/account/data-exports/x/content?exp=1&sig=2',
        });
      await d.tap(find.byKey(const Key('requestExport')));
      expect(find.byKey(const Key('exportDownload')), findsOneWidget);
      await d.tap(find.byKey(const Key('exportDownload')));
      expect(d.opened.single.toString(), contains('/data-exports/x/content'));
    });

    testWidgets('delete account: confirm → stale sign-in → password → re-auth → retried → signed out', (tester) async {
      final d = await open(tester);
      var calls = 0;
      d.server.stubs['DELETE /v1/account'] = (o) => ++calls == 1 ? reply(401, fixture('error_reauth_required')) : reply(202, {'requestId': 'r', 'status': 'received'});
      await tester.dragUntilVisible(find.byKey(const Key('deleteAccount')), find.byType(ListView).first, const Offset(0, -300));
      await d.tap(find.byKey(const Key('deleteAccount')));
      await d.tap(find.byKey(const Key('confirmDeleteAccount')));
      expect(find.byKey(const Key('reauthPassword')), findsOneWidget);
      expect(d.h.auth.signOutCalls, 0, reason: 'REAUTH_REQUIRED is not a logout');
      await tester.enterText(find.byKey(const Key('reauthPassword')), 'my-password');
      await d.tap(find.byKey(const Key('reauthSubmit')));
      expect(d.h.auth.reauthCalls, 1);
      expect(calls, 2);
      expect(d.h.auth.signOutCalls, 1);
    });

    testWidgets('a wrong password asks again and does not delete', (tester) async {
      final d = await open(tester);
      d.server.stubs['DELETE /v1/account'] = (o) => reply(401, fixture('error_reauth_required'));
      d.h.auth.failReauth = const AuthFailure(AuthFailureReason.invalidCredentials);
      await tester.dragUntilVisible(find.byKey(const Key('deleteAccount')), find.byType(ListView).first, const Offset(0, -300));
      await d.tap(find.byKey(const Key('deleteAccount')));
      await d.tap(find.byKey(const Key('confirmDeleteAccount')));
      await tester.enterText(find.byKey(const Key('reauthPassword')), 'nope');
      await d.tap(find.byKey(const Key('reauthSubmit')));
      expect(find.byKey(const Key('reauthWrong')), findsOneWidget);
      expect(d.h.auth.signOutCalls, 0);
    });

    testWidgets('cancelling the delete confirmation does nothing', (tester) async {
      final d = await open(tester);
      await tester.dragUntilVisible(find.byKey(const Key('deleteAccount')), find.byType(ListView).first, const Offset(0, -300));
      await d.tap(find.byKey(const Key('deleteAccount')));
      await d.tap(find.text('Cancel'));
      expect(d.logs('DELETE', '/v1/account'), isEmpty);
    });
  });
}

