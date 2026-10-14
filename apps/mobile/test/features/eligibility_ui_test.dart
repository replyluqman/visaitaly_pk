import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/app/router.dart';
import 'package:visaitaly_pk/core/session/session_state.dart';

import '../helpers/app_driver.dart';
import '../helpers/fake_server.dart';
import '../helpers/fakes.dart';

void main() {
  group('routing for signed-out users', () {
    test('first open → Quick Check; returning → Login; Quick Check, Login and How We Verify stay reachable', () {
      const s = SessionSignedOut();
      expect(computeRedirect(s, Routes.splash, firstOpen: true), Routes.eligibility);
      expect(computeRedirect(s, Routes.splash), Routes.login);
      expect(computeRedirect(s, Routes.eligibility, firstOpen: true), isNull);
      expect(computeRedirect(s, Routes.eligibility), isNull);
      expect(computeRedirect(s, Routes.verify), isNull);
      expect(computeRedirect(s, Routes.home), Routes.login, reason: 'everything else needs an account');
      expect(computeRedirect(s, Routes.support), Routes.login);
    });
  });

  group('Eligibility Quick Check (Screen 2)', () {
    FakeServer server() => FakeServer()
      ..stub('GET /v1/public/eligibility-check', fixture('eligibility_questions'))
      ..stub('POST /v1/public/eligibility-check', fixture('eligibility_result'));

    testWidgets('first open lands on the Quick Check — no account, no token, no device id on any request', (tester) async {
      final d = await pumpSignedOut(tester, server(), firstOpen: true);
      expect(find.byKey(const Key('eligStart')), findsOneWidget);
      expect(find.byKey(const Key('eligDisclaimerIntro')), findsOneWidget);
      for (final r in d.h.adapter.requests) {
        expect(r.headers.containsKey('Authorization'), isFalse, reason: r.path);
        expect(r.headers.containsKey('X-Device-Id'), isFalse, reason: r.path);
      }
    });

    testWidgets('answer the questions → result is CMS orientation text with typical items, a locked count and the disclaimer', (tester) async {
      final srv = server();
      final d = await pumpSignedOut(tester, srv, firstOpen: true);
      await d.tap(find.byKey(const Key('eligStart')));
      expect(find.text('Question 1 of 2'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('eligNext'))).onPressed, isNull, reason: 'pick an option first');
      await d.tap(find.byKey(const Key('opt_spouse')));
      await d.tap(find.byKey(const Key('eligNext')));
      expect(find.text('Question 2 of 2'), findsOneWidget);
      await d.tap(find.byKey(const Key('eligBack')));
      expect(find.text('Question 1 of 2'), findsOneWidget);
      await d.tap(find.byKey(const Key('eligNext')));
      await d.tap(find.byKey(const Key('opt_pakistan')));
      await d.tap(find.byKey(const Key('eligNext'))); // "See the result"

      final sent = d.logs('POST', '/v1/public/eligibility-check').single.data as Map;
      expect(sent, {'version': 1, 'answers': {'who': 'spouse', 'where': 'pakistan'}});
      expect(find.text('Spouse applications typically involve these documents.'), findsOneWidget);
      expect(find.byKey(const Key('typical_passport')), findsOneWidget);
      expect(find.byKey(const Key('eligLocked')), findsOneWidget);
      expect(find.text('Orientation only.'), findsOneWidget);
      // the result never states a verdict
      expect(find.textContaining(RegExp('eligible|qualify|approved', caseSensitive: false)), findsNothing);
    });

    testWidgets('WhatsApp opens the CMS link; "Create an account" goes to Login and the Quick Check is not offered again', (tester) async {
      final srv = server();
      final d = await pumpSignedOut(tester, srv, firstOpen: true);
      await d.tap(find.byKey(const Key('eligStart')));
      await d.tap(find.byKey(const Key('opt_spouse')));
      await d.tap(find.byKey(const Key('eligNext')));
      await d.tap(find.byKey(const Key('opt_italy')));
      await d.tap(find.byKey(const Key('eligNext')));
      await d.tap(find.byKey(const Key('eligWhatsapp')));
      expect(d.opened.single.toString(), 'https://wa.me/390000000000');
      await d.tap(find.byKey(const Key('eligCreate')));
      expect(find.byKey(const Key('submit')), findsOneWidget); // Login
    });

    testWidgets('a stale question set (422 details.version) reloads and restarts with a notice', (tester) async {
      final srv = server();
      srv.stub('POST /v1/public/eligibility-check', fixture('error_eligibility_stale_version'), status: 422);
      final d = await pumpSignedOut(tester, srv, firstOpen: true);
      await d.tap(find.byKey(const Key('eligStart')));
      await d.tap(find.byKey(const Key('opt_spouse')));
      await d.tap(find.byKey(const Key('eligNext')));
      await d.tap(find.byKey(const Key('opt_italy')));
      await d.tap(find.byKey(const Key('eligNext')));
      expect(find.byKey(const Key('eligStale')), findsOneWidget);
      expect(d.logs('GET', '/v1/public/eligibility-check').length, greaterThanOrEqualTo(2));
    });

    testWidgets('no published version (404) says it is unavailable and still lets the user move on', (tester) async {
      final srv = FakeServer()..stub('GET /v1/public/eligibility-check', {'error': {'code': 'NOT_FOUND', 'message': 'x', 'requestId': 'r'}}, status: 404);
      final d = await pumpSignedOut(tester, srv, firstOpen: true);
      expect(find.text("The quick check isn't available right now."), findsOneWidget);
      await d.tap(find.text('Skip for now').last);
      expect(find.byKey(const Key('submit')), findsOneWidget);
    });

    testWidgets('skipping goes to Login', (tester) async {
      final d = await pumpSignedOut(tester, server(), firstOpen: true);
      await d.tap(find.byKey(const Key('eligSkip')));
      expect(find.byKey(const Key('submit')), findsOneWidget);
    });

    testWidgets('a returning visitor goes straight to Login', (tester) async {
      await pumpSignedOut(tester, server(), firstOpen: false);
      expect(find.byKey(const Key('submit')), findsOneWidget);
    });
  });
}
