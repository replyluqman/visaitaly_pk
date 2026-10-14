import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/file_picker_gateway.dart';

import '../helpers/app_driver.dart';
import '../helpers/fakes.dart';

void main() {
  group('Today (Screen 9)', () {
    testWidgets('actions become sentences built on the client from kind/reason/dueDate', (tester) async {
      final s = completeServer()..stub('GET /v1/today', {
        'actions': [
          {'kind': 'expiring', 'reason': 'document_expires', 'title': 'Passport', 'applicantId': 'a1', 'itemId': 'i1', 'dueDate': '2026-12-31', 'deepLink': '/checklist/00000000-0000-4000-8000-000000000001'},
          {'kind': 'blocking', 'reason': 'blocks_submission', 'title': 'Nikah', 'applicantId': 'a1', 'itemId': 'i2', 'dueDate': null, 'deepLink': '/checklist/00000000-0000-4000-8000-000000000002'},
          {'kind': 'expiring', 'reason': 'nulla_osta_expires', 'title': null, 'applicantId': 'a1', 'itemId': null, 'dueDate': '2027-02-01', 'deepLink': '/applicants/00000000-0000-4000-8000-000000000003'},
          {'kind': 'todo', 'reason': 'issue_found', 'title': 'Photo', 'applicantId': 'a1', 'itemId': 'i4', 'dueDate': null, 'deepLink': '/checklist/00000000-0000-4000-8000-000000000004'},
          {'kind': 'todo', 'reason': 'in_progress', 'title': 'Form', 'applicantId': 'a1', 'itemId': 'i5', 'dueDate': null, 'deepLink': '/checklist/00000000-0000-4000-8000-000000000005'},
        ],
        'allClear': null,
        'computedAt': '2026-10-14T00:00:00Z',
      });
      final d = await pumpSignedIn(tester, s);
      await d.go('/today');
      expect(find.text('Passport expires Dec 31, 2026'), findsOneWidget);
      expect(find.text('Nikah is blocking submission'), findsOneWidget);
      expect(find.text('Nulla Osta expires Feb 1, 2027'), findsOneWidget);
      expect(find.text('Issue found: Photo'), findsOneWidget);
      expect(find.text('Continue: Form'), findsOneWidget);
    });

    testWidgets('tapping an action follows its whitelisted deep link; a hostile link is ignored', (tester) async {
      const good = '00000000-0000-4000-8000-000000000001';
      final s = completeServer()
        ..stub('GET /v1/today', {
          'actions': [
            {'kind': 'blocking', 'reason': 'blocks_submission', 'title': 'Good', 'applicantId': 'a1', 'itemId': 'x', 'dueDate': null, 'deepLink': '/checklist/$good'},
            {'kind': 'blocking', 'reason': 'blocks_submission', 'title': 'Evil', 'applicantId': 'a1', 'itemId': 'y', 'dueDate': null, 'deepLink': 'https://evil.example/phish'},
          ],
          'allClear': null,
          'computedAt': '2026-10-14T00:00:00Z',
        })
        ..stub('~GET /v1/checklist/.+', fixture('checklist_item_detail'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/today');
      await d.tap(find.byKey(const Key('action_1')));
      expect(find.text('Evil is blocking submission'), findsOneWidget, reason: 'still on Today');
      await d.tap(find.byKey(const Key('action_0')));
      expect(d.logs('GET', '/v1/checklist/$good'), hasLength(1));
    });

    testWidgets('all clear names the next stage', (tester) async {
      final s = completeServer()..stub('GET /v1/today', fixture('today_all_clear'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/today');
      expect(find.byKey(const Key('todayAllClear')), findsOneWidget);
      expect(find.text('Nothing needs you today — next stage: Translation'), findsOneWidget);
    });

    testWidgets('"not computed yet" (computedAt null, nothing listed) is NOT shown as all clear', (tester) async {
      final s = completeServer()..stub('GET /v1/today', {'actions': [], 'allClear': null, 'computedAt': null});
      final d = await pumpSignedIn(tester, s);
      await d.go('/today');
      expect(find.byKey(const Key('todayPreparing')), findsOneWidget);
      expect(find.byKey(const Key('todayAllClear')), findsNothing);
    });

    testWidgets('free account: PREMIUM_REQUIRED shows the paywall preview, not an error', (tester) async {
      final s = completeServer()..stub('GET /v1/today', fixture('error_premium_required_today'), status: 402);
      final d = await pumpSignedIn(tester, s);
      await d.go('/today');
      expect(find.byKey(const Key('todayLocked')), findsOneWidget);
      await d.tap(find.text('Part of Premium'));
      expect(find.byKey(const Key('paywallNoPurchase')), findsOneWidget);
    });
  });

  group('My Documents (Screen 14)', () {
    testWidgets('empty state uses the specified copy', (tester) async {
      final s = completeServer()..stub('GET /v1/documents', {'items': [], 'nextCursor': null, 'quota': {'usedBytes': 0, 'maxBytes': 1000}});
      final d = await pumpSignedIn(tester, s);
      await d.go('/documents');
      expect(find.text("Start with your passport — it's needed at every stage"), findsOneWidget);
    });

    testWidgets('lists files with applicant name and the quota the SERVER reports', (tester) async {
      final s = completeServer()..stub('GET /v1/documents', fixture('documents_list'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/documents');
      final doc = (fixture('documents_list')['items'] as List).first as Map<String, dynamic>;
      expect(find.byKey(Key('doc_${doc['id']}')), findsOneWidget);
      expect(find.byKey(const Key('quota')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('quota'))).data, '100 B of 500.0 MB used');
    });

    testWidgets('with two applicants: filter chips ask for that applicant; upload asks whose document it is', (tester) async {
      final s = completeServer(applicants: 2)
        ..stub('GET /v1/documents', fixture('documents_list'))
        ..stub('POST /v1/documents/upload-url', fixture('document_upload_url'))
        ..stub('~PUT /v1/documents/.+/content', null, status: 204)
        ..stub('~POST /v1/documents/.+/complete', fixture('document_complete'));
      final d = await pumpSignedIn(tester, s, pick: PickedFile(name: 'p.png', bytes: Uint8List(32), mime: 'image/png'));
      await d.go('/documents');
      await d.tap(find.byKey(const Key('docFilter_a2')));
      expect(d.h.adapter.requests.where((r) => r.path == '/v1/documents').last.queryParameters['applicantId'], 'a2');
      await d.tap(find.byKey(const Key('docFilterAll')));
      await d.tap(find.byKey(const Key('uploadDoc')));
      expect(find.text('Whose document is this?'), findsOneWidget);
      await d.tap(find.byKey(const Key('pick_a2')));
      final reserve = d.logs('POST', '/v1/documents/upload-url').single.data as Map;
      expect(reserve['applicantId'], 'a2');
      expect(reserve.containsKey('checklistItemId'), isFalse, reason: 'an unlinked upload');
    });

    testWidgets('a document linked to a checklist item opens that item', (tester) async {
      final doc = (fixture('documents_list')['items'] as List).first as Map<String, dynamic>;
      final s = completeServer()
        ..stub('GET /v1/documents', fixture('documents_list'))
        ..stub('~GET /v1/checklist/.+', fixture('checklist_item_detail'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/documents');
      await d.tap(find.byTooltip('Linked to a checklist item'));
      expect(d.logs('GET', '/v1/checklist/${doc['checklistItemId']}'), hasLength(1));
    });
  });

  group('Notification Center (Screen 13)', () {
    Map<String, dynamic> list(List<Map<String, dynamic>> items) => {'items': items, 'nextCursor': null};
    Map<String, dynamic> notif(String id, {String? readAt, String link = '/documents', String tab = 'update'}) => {
          'id': id, 'tab': tab, 'type': 'requirement_changed', 'title': 'Title $id', 'body': 'Body $id',
          'deepLink': link, 'applicantId': null, 'createdAt': '2026-10-14T00:00:00Z', 'readAt': readAt,
        };

    testWidgets('three tabs with unread counts; the bell shows the total', (tester) async {
      final s = completeServer()
        ..stub('GET /v1/notifications/unread-count', {'total': 3, 'byTab': {'reminder': 1, 'update': 2, 'activity': 0}})
        ..stub('~GET /v1/notifications', list([]));
      final d = await pumpSignedIn(tester, s);
      expect(find.text('3'), findsOneWidget); // bell badge on Home
      await d.tap(find.byKey(const Key('bell')));
      expect(find.text('Reminders (1)'), findsOneWidget);
      expect(find.text('Updates (2)'), findsOneWidget);
      expect(find.text('Activity'), findsOneWidget);
    });

    testWidgets('empty tab uses the specified copy', (tester) async {
      final s = completeServer()..stub('~GET /v1/notifications', list([]));
      final d = await pumpSignedIn(tester, s);
      await d.go('/notifications');
      expect(find.text("You're up to date. We check official sources daily."), findsOneWidget);
    });

    testWidgets('tap: marks read, then follows the deep link', (tester) async {
      const target = '00000000-0000-4000-8000-0000000000aa';
      final s = completeServer()
        ..stubs['~GET /v1/notifications'] = ((o) => o.queryParameters['tab'] == 'reminder'
            ? reply(200, list([notif('n1', link: '/checklist/$target', tab: 'reminder')]))
            : reply(200, list([])))
        ..stub('~POST /v1/notifications/.+/read', null, status: 204)
        ..stub('~GET /v1/checklist/.+', fixture('checklist_item_detail'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/notifications');
      await d.tap(find.byKey(const Key('notif_n1')));
      expect(d.logs('POST', '/v1/notifications/n1/read'), hasLength(1));
      expect(d.logs('GET', '/v1/checklist/$target'), hasLength(1));
    });

    testWidgets('an already-read notification is not re-marked; a hostile deep link is never followed', (tester) async {
      final s = completeServer()
        ..stubs['~GET /v1/notifications'] = ((o) => o.queryParameters['tab'] == 'reminder'
            ? reply(200, list([notif('n1', readAt: '2026-10-14T01:00:00Z', link: 'https://evil.example', tab: 'reminder')]))
            : reply(200, list([])));
      final d = await pumpSignedIn(tester, s);
      await d.go('/notifications');
      await d.tap(find.byKey(const Key('notif_n1')));
      expect(d.logs('POST', '/read'), isEmpty);
      expect(find.text('Title n1'), findsOneWidget, reason: 'stayed on the inbox');
    });

    testWidgets('mark all as read posts the tab and refreshes', (tester) async {
      final s = completeServer()
        ..stubs['~GET /v1/notifications'] = ((o) => o.queryParameters['tab'] == 'reminder'
            ? reply(200, list([notif('n1', tab: 'reminder'), notif('n2', tab: 'reminder')]))
            : reply(200, list([])))
        ..stub('POST /v1/notifications/read-all', null, status: 204);
      final d = await pumpSignedIn(tester, s);
      await d.go('/notifications');
      await d.tap(find.byKey(const Key('markAll')));
      expect((d.logs('POST', 'read-all').single.data as Map)['tab'], 'reminder');
    });
  });

  group('How We Verify (Screen 15)', () {
    testWidgets('shows the live stats; "not checked yet" until a sweep exists; open flags are surfaced, not hidden', (tester) async {
      final s = completeServer()..stub('GET /v1/public/verification-summary', {...fixture('verification_summary'), 'openFlags': 2});
      final d = await pumpSignedIn(tester, s);
      await d.go('/verify');
      expect(find.byKey(const Key('verifyTracked')), findsOneWidget);
      expect(find.text('100% linked to an official source'), findsOneWidget);
      expect(find.text('Not checked yet'), findsOneWidget);
      expect(find.text('2 sources under review'), findsOneWidget);
      expect(find.byKey(const Key('verifyNoRecent')), findsOneWidget);
      expect(d.h.adapter.requests.where((r) => r.path.contains('verification-summary')).single.headers.containsKey('Authorization'), isFalse);
    });

    testWidgets('recent updates list what changed and when it is effective', (tester) async {
      final s = completeServer()
        ..stub('GET /v1/public/verification-summary', {
          ...fixture('verification_summary'),
          'recentUpdates': [
            {'requirementTitle': 'Nikah certificate', 'changeSummary': 'Attestation now required', 'effectiveDate': '2026-10-01'},
          ],
        });
      final d = await pumpSignedIn(tester, s);
      await d.go('/verify');
      expect(find.text('Nikah certificate'), findsOneWidget);
      expect(find.textContaining('Attestation now required'), findsOneWidget);
      expect(find.textContaining('Effective Oct 1, 2026'), findsOneWidget);
    });
  });
}
