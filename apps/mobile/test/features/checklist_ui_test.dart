import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/file_picker_gateway.dart';

import '../helpers/app_driver.dart';
import '../helpers/fakes.dart';

Map<String, dynamic> premiumList() => fixture('checklist_premium');

void main() {
  group('Applicant Case View (Screen 10)', () {
    testWidgets('dashboard card → case view: readiness, the personalization line, blocking count, the list', (tester) async {
      final s = completeServer()..stub('~GET /v1/applicants/a1/checklist', premiumList());
      final d = await pumpSignedIn(tester, s);
      await d.tap(find.byKey(const Key('applicant_a1')));

      final r = (fixture('applicants_list')['applicants'] as List).first['readiness'] as Map<String, dynamic>;
      final total = (r['applicableCount'] as int) + (r['notApplicableCount'] as int);
      expect(find.byKey(const Key('personalization')), findsOneWidget);
      expect(
        tester.widget<Text>(find.byKey(const Key('personalization'))).data,
        '$total requirements · ${r['categorySpecificCount']} specific to Spouse category · ${r['notApplicableCount']} not applicable to you',
      );
      expect(find.byKey(const Key('blockingCount')), findsOneWidget);
      // rows are present, with status chips (icon + label)
      final first = (premiumList()['items'] as List).first['title'] as String;
      expect(find.text(first), findsWidgets);
    });

    testWidgets('not-applicable rows are shown greyed WITH their reason, never hidden', (tester) async {
      final s = completeServer()..stub('~GET /v1/applicants/a1/checklist', premiumList());
      final d = await pumpSignedIn(tester, s);
      await d.go('/applicants/a1');
      await tester.dragUntilVisible(find.byKey(const Key('naReason')).first, find.byType(CustomScrollView), const Offset(0, -300));
      expect(find.byKey(const Key('naReason')), findsWidgets);
      expect(find.text('Not applicable'), findsWidgets);
    });

    testWidgets('a filter chip asks the SERVER (blocking=true) and the list reloads; All clears it', (tester) async {
      final s = completeServer()
        ..stub('~GET /v1/applicants/a1/checklist', premiumList());
      final d = await pumpSignedIn(tester, s);
      await d.go('/applicants/a1');
      await d.tap(find.byKey(const Key('fBlocking')));
      final reqs = d.h.adapter.requests.where((r) => r.path == '/v1/applicants/a1/checklist').toList();
      expect(reqs.last.queryParameters['blocking'], true);
      await d.tap(find.byKey(const Key('fAll')));
      expect(d.h.adapter.requests.where((r) => r.path == '/v1/applicants/a1/checklist').last.queryParameters.containsKey('blocking'), isFalse);
    });

    testWidgets('search narrows the loaded rows by title', (tester) async {
      final s = completeServer()..stub('~GET /v1/applicants/a1/checklist', premiumList());
      final d = await pumpSignedIn(tester, s);
      await d.go('/applicants/a1');
      final items = (premiumList()['items'] as List).cast<Map<String, dynamic>>();
      final keep = items.first['title'] as String;
      final other = items.firstWhere((i) => i['title'] != keep)['title'] as String;
      await tester.enterText(find.byKey(const Key('search')), keep);
      await tester.pumpAndSettle();
      expect(find.text(keep), findsWidgets);
      expect(find.text(other), findsNothing);
      await tester.enterText(find.byKey(const Key('search')), 'zzzz-no-match');
      await tester.pumpAndSettle();
      expect(find.text('No items match your search or filters.'), findsOneWidget);
    });

    testWidgets('free tier: only the preview rows, "+N more documents", and a paywall preview with NO purchase button', (tester) async {
      final s = completeServer()..stub('~GET /v1/applicants/a1/checklist', fixture('checklist_free'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/applicants/a1');
      final locked = fixture('checklist_free')['lockedCount'] as int;
      await tester.dragUntilVisible(find.byKey(const Key('lockedRows')), find.byType(CustomScrollView), const Offset(0, -300));
      expect(find.text('+$locked more documents'), findsOneWidget);
      await d.tap(find.byKey(const Key('lockedRows')));
      expect(find.text('Part of Premium'), findsOneWidget);
      expect(find.byKey(const Key('paywallNoPurchase')), findsOneWidget);
      expect(find.textContaining('€'), findsNothing, reason: 'no price is shown until checkout exists');
      expect(find.byKey(const Key('paywallVerify')), findsOneWidget);
      expect(find.byKey(const Key('paywallAsk')), findsOneWidget);
    });

    testWidgets('pagination: scrolling near the end requests the next page with the opaque cursor', (tester) async {
      final page1 = premiumList()..['nextCursor'] = 'CURSOR-2';
      var calls = 0;
      final s = completeServer();
      s.stubs['~GET /v1/applicants/a1/checklist'] = (o) {
        calls++;
        if (o.queryParameters['cursor'] == 'CURSOR-2') {
          final p2 = premiumList();
          (p2['items'] as List).clear();
          p2['nextCursor'] = null;
          return reply(200, p2);
        }
        return reply(200, page1);
      };
      final d = await pumpSignedIn(tester, s, size: const Size(800, 500));
      await d.go('/applicants/a1');
      await tester.drag(find.byType(CustomScrollView), const Offset(0, -5000));
      await tester.pumpAndSettle();
      expect(d.h.adapter.requests.any((r) => r.queryParameters['cursor'] == 'CURSOR-2'), isTrue);
      expect(calls, greaterThanOrEqualTo(2));
    });

    testWidgets('the Nulla Osta card expands in place and shows days remaining', (tester) async {
      final s = completeServer()..stub('~GET /v1/applicants/a1/checklist', premiumList());
      final d = await pumpSignedIn(tester, s);
      await d.go('/applicants/a1');
      expect(find.byKey(const Key('nullaDays')), findsOneWidget);
      await d.tap(find.byKey(const Key('nullaCard')));
      expect(find.textContaining('Issued'), findsOneWidget);
      expect(find.textContaining('Expires'), findsWidgets);
    });

    testWidgets('a grace-period applicant sees the read-only banner', (tester) async {
      final s = completeServer(canWrite: false)..stub('~GET /v1/applicants/a1/checklist', premiumList());
      final d = await pumpSignedIn(tester, s);
      await d.go('/applicants/a1');
      expect(find.byKey(const Key('readOnlyBanner')), findsOneWidget);
    });
  });

  group('Checklist Item Detail (Screen 11)', () {
    Map<String, dynamic> detail([void Function(Map<String, dynamic>)? tweak]) {
      final m = fixture('checklist_item_detail')..['id'] = 'i1'; // the route id, as on a real device
      tweak?.call(m);
      return m;
    }

    testWidgets('"Verified 12 days ago" is at the TOP (before the title and body), purpose/source/footer present', (tester) async {
      final s = completeServer()..stub('~GET /v1/checklist/.+', detail());
      final d = await pumpSignedIn(tester, s);
      await d.go('/checklist/i1');
      // the fixture's lastVerifiedAt is 12 days before the capture date; the app clock is fixed in the harness,
      // so assert on the stamp's presence/position rather than the number.
      expect(find.byKey(const Key('verifiedStamp')), findsOneWidget);
      final stampY = tester.getTopLeft(find.byKey(const Key('verifiedStamp'))).dy;
      final purposeY = tester.getTopLeft(find.text('Proof of marriage')).dy;
      expect(stampY, lessThan(purposeY));
      expect(find.text('Proof of marriage'), findsOneWidget);
      expect(find.text('Union council'), findsOneWidget);
      expect(find.byKey(const Key('verifyOfficial')), findsOneWidget);
    });

    testWidgets('"Verify with official source" opens the source URL', (tester) async {
      final s = completeServer()..stub('~GET /v1/checklist/.+', detail());
      final d = await pumpSignedIn(tester, s);
      await d.go('/checklist/i1');
      await d.tap(find.byKey(const Key('verifyOfficial')));
      expect(d.opened.single.toString(), 'https://example.test/src');
    });

    testWidgets('changing status PATCHes the wire value, then re-reads the item', (tester) async {
      final s = completeServer();
      s.stub('~GET /v1/checklist/.+', detail());
      s.stub('~PATCH /v1/checklist/.+', fixture('checklist_item_patched'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/checklist/i1');
      final before = d.logs('GET', '/v1/checklist/').length;
      expect(before, 1);
      await d.tap(find.byKey(const Key('status_ready')));
      final patch = d.logs('PATCH', '/v1/checklist/').single;
      expect((patch.data as Map)['status'], 'ready');
      expect(d.logs('GET', '/v1/checklist/').length, greaterThan(before));
    });

    testWidgets('read-only (grace/expired): status chips are disabled and the note says why', (tester) async {
      final s = completeServer()..stub('~GET /v1/checklist/.+', detail((m) => m['canWrite'] = false));
      final d = await pumpSignedIn(tester, s);
      await d.go('/checklist/i1');
      expect(find.byKey(const Key('itemReadOnly')), findsOneWidget);
      expect(tester.widget<ChoiceChip>(find.byKey(const Key('status_ready'))).onSelected, isNull);
      expect(find.byKey(const Key('addDocument')), findsNothing);
    });

    testWidgets('a not-applicable item is read-only with the rule reason and no status selector', (tester) async {
      final s = completeServer()..stub('~GET /v1/checklist/.+', fixture('checklist_item_not_applicable')..['id'] = 'i1');
      final d = await pumpSignedIn(tester, s);
      await d.go('/checklist/i1');
      expect(find.byKey(const Key('naReasonDetail')), findsOneWidget);
      expect(find.byKey(const Key('status_ready')), findsNothing);
    });

    testWidgets('PREMIUM_REQUIRED shows the locked state (not an error) that leads to the paywall preview', (tester) async {
      final s = completeServer()..stub('~GET /v1/checklist/.+', fixture('error_premium_required'), status: 402);
      final d = await pumpSignedIn(tester, s);
      await d.go('/checklist/i1');
      expect(find.byKey(const Key('itemLocked')), findsOneWidget);
      await d.tap(find.text('Part of Premium'));
      expect(find.byKey(const Key('paywallNoPurchase')), findsOneWidget);
    });

    testWidgets('needs-review badge: the acknowledge button calls the server', (tester) async {
      final s = completeServer();
      s.stub('~GET /v1/checklist/.+', detail((m) => m['badges'] = ['needs_review']));
      s.stub('~POST /v1/checklist/.+/acknowledge-review', fixture('checklist_item_patched'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/checklist/i1');
      expect(find.byKey(const Key('ackHint')), findsOneWidget);
      await d.tap(find.byKey(const Key('ackButton')));
      expect(d.logs('POST', 'acknowledge-review'), hasLength(1));
    });

    testWidgets('adding a document: picks, reserves, PUTs to the signed URL (no token), completes — linked to THIS item and applicant', (tester) async {
      final s = completeServer();
      s.stub('~GET /v1/checklist/.+', detail((m) => m['applicantId'] = 'a1'));
      s.stub('POST /v1/documents/upload-url', fixture('document_upload_url'));
      s.stub('~PUT /v1/documents/.+/content', null, status: 204);
      s.stub('~POST /v1/documents/.+/complete', fixture('document_complete'));
      final bytes = Uint8List.fromList(List.generate(64, (i) => i));
      final d = await pumpSignedIn(tester, s, pick: PickedFile(name: 'x.png', bytes: bytes, mime: 'image/png'));
      await d.go('/checklist/i1');
      await d.tap(find.byKey(const Key('addDocument')));
      final reserve = d.logs('POST', '/v1/documents/upload-url').single.data as Map;
      expect(reserve['applicantId'], 'a1');
      expect(reserve['checklistItemId'], 'i1');
      expect(reserve['sizeBytes'], 64);
      final put = d.h.adapter.requests.firstWhere((r) => r.method == 'PUT');
      expect(put.headers.containsKey('Authorization'), isFalse);
      expect(d.logs('POST', '/complete'), hasLength(1));
    });

    testWidgets('cancelling the picker is not an error and uploads nothing', (tester) async {
      final s = completeServer()..stub('~GET /v1/checklist/.+', detail());
      final d = await pumpSignedIn(tester, s, pick: null);
      await d.go('/checklist/i1');
      await d.tap(find.byKey(const Key('addDocument')));
      expect(d.picker.calls, 1);
      expect(d.logs('POST', '/v1/documents/upload-url'), isEmpty);
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('a rejected upload says so and nothing is completed', (tester) async {
      final s = completeServer();
      s.stub('~GET /v1/checklist/.+', detail());
      s.stub('POST /v1/documents/upload-url', fixture('document_upload_url'));
      s.stub('~PUT /v1/documents/.+/content', errorBody('UPLOAD_REJECTED'), status: 422);
      final d = await pumpSignedIn(tester, s, pick: PickedFile(name: 'x.png', bytes: Uint8List(8), mime: 'image/png'));
      await d.go('/checklist/i1');
      await d.tap(find.byKey(const Key('addDocument')));
      expect(find.text("Couldn't upload the file. Please try again."), findsOneWidget);
      expect(d.logs('POST', '/complete'), isEmpty);
    });

    testWidgets('the server states the limit when a file is too large (message shown verbatim)', (tester) async {
      final s = completeServer();
      s.stub('~GET /v1/checklist/.+', detail());
      s.stub('POST /v1/documents/upload-url', errorBody('UPLOAD_TOO_LARGE', message: 'Files can be at most 10 MB.'), status: 413);
      final d = await pumpSignedIn(tester, s, pick: PickedFile(name: 'x.png', bytes: Uint8List(8), mime: 'image/png'));
      await d.go('/checklist/i1');
      await d.tap(find.byKey(const Key('addDocument')));
      expect(find.text('Files can be at most 10 MB.'), findsOneWidget);
    });

    testWidgets('deleting a document asks first, then calls DELETE', (tester) async {
      final s = completeServer();
      s.stub('~GET /v1/checklist/.+', detail((m) => m['documents'] = [fixture('document_complete')]));
      s.stub('~DELETE /v1/documents/.+', null, status: 204);
      final d = await pumpSignedIn(tester, s);
      await d.go('/checklist/i1');
      await tester.tap(find.byTooltip('Delete'));
      await tester.pumpAndSettle();
      expect(d.logs('DELETE', '/v1/documents/'), isEmpty, reason: 'must confirm first');
      await d.tap(find.byKey(const Key('confirmDelete')));
      expect(d.logs('DELETE', '/v1/documents/'), hasLength(1));
    });
  });

  group('Journey (Screen 12)', () {
    testWidgets('all 8 stages with done / current / upcoming and ready counts', (tester) async {
      final s = completeServer()..stub('GET /v1/applicants/a1/journey', fixture('journey'));
      final d = await pumpSignedIn(tester, s);
      await d.go('/applicants/a1/journey');
      for (final k in ['eligibility', 'nullaOsta', 'documents', 'translation', 'appointment', 'application', 'processing', 'decision']) {
        expect(find.byKey(Key('stage_$k')), findsOneWidget, reason: k);
      }
      expect(find.text('You are here'), findsOneWidget);
    });
  });
}
