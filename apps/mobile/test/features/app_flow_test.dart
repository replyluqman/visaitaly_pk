import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/app/app.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/network/api_error.dart';

import '../helpers/fake_server.dart';
import '../helpers/fakes.dart';
import '../helpers/harness.dart';

Future<Harness> pumpApp(WidgetTester tester, FakeServer server, {AuthUser? user}) async {
  tester.view.physicalSize = const Size(800, 1800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final h = harness(server.handle, user: user);
  await tester.pumpWidget(ProviderScope(retry: (_, _) => null, overrides: h.overrides.cast(), child: const VisaItalyApp()));
  await tester.pumpAndSettle();
  return h;
}

Finder text(String t) => find.text(t);

Future<void> addApplicant(WidgetTester tester, {required String name, required String relationship, bool dob = false}) async {
  await tester.enterText(find.byKey(const Key('name')), name);
  await tester.tap(find.byKey(const Key('relationship')));
  await tester.pumpAndSettle();
  await tester.tap(find.text(relationship).last);
  await tester.pumpAndSettle();
  if (dob) {
    await tester.tap(find.byKey(const Key('dob')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
  }
  await tester.tap(find.byKey(const Key('save')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('new user: login → disclaimer → count → 2 applicants → stage → dashboard (server-driven routing)', (tester) async {
    final server = FakeServer();
    final h = await pumpApp(tester, server);

    // Splash → Login (no Firebase user)
    expect(find.byKey(const Key('submit')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('email')), 'new@example.com');
    await tester.enterText(find.byKey(const Key('password')), 'correct horse');
    await tester.tap(find.byKey(const Key('toggle'))); // create account
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('submit')));
    await tester.pumpAndSettle();

    // Registered the device, then the legal gate is shown because the SERVER says acceptance is pending.
    expect(server.log.where((r) => r.path == '/v1/auth/session'), hasLength(1));
    expect(find.byKey(const Key('legalAccept')), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const Key('legalAccept'))).onPressed, isNull); // needs the checkbox
    await tester.tap(find.byKey(const Key('legalCheck')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('legalAccept')));
    await tester.pumpAndSettle();

    // Applicant count: 2
    expect(find.byKey(const Key('countContinue')), findsOneWidget);
    await tester.tap(find.byKey(const Key('count2')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('countContinue')));
    await tester.pumpAndSettle();

    // Applicant 1 of 2 (wife: no DOB needed)
    expect(text('Applicant 1 of 2'), findsOneWidget);
    await addApplicant(tester, name: 'Ayesha', relationship: 'Wife');

    // Applicant 2 of 2 (son: DOB required — saving without it is blocked client-side)
    expect(text('Applicant 2 of 2'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('name')), 'Ali');
    await tester.tap(find.byKey(const Key('relationship')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Son').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('save')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('dobError')), findsOneWidget);
    expect(server.applicants, hasLength(1));
    await tester.tap(find.byKey(const Key('dob')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('save')));
    await tester.pumpAndSettle();
    expect(server.applicants, hasLength(2));
    final sentSon = server.log.where((r) => r.method == 'POST' && r.path == '/v1/applicants').last.data as Map;
    expect(sentSon['dateOfBirth'], matches(RegExp(r'^\d{4}-\d{2}-\d{2}$')));
    expect(sentSon.containsKey('relationshipCategory'), isFalse);

    // Stage selection: first applicant (Ayesha) then second
    expect(text('For Ayesha. This only sets your starting point; you can change it later.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('stage_nullaOstaReceived')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('stageContinue')));
    await tester.pumpAndSettle();
    // Screen 7 → (stage, nullaOstaStatus): tracker state patched, then stage written
    final patches = server.log.where((r) => r.method == 'PATCH' && r.path.startsWith('/v1/applicants/')).toList();
    expect((patches.first.data as Map)['nullaOstaStatus'], 'received');
    expect((patches.last.data as Map)['currentStage'], 'nulla_osta');

    expect(text('For Ali. This only sets your starting point; you can change it later.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('stage_documents')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('stageContinue')));
    await tester.pumpAndSettle();

    // Dashboard
    expect(text('Your family'), findsOneWidget);
    expect(find.byKey(const Key('applicant_a1')), findsOneWidget);
    expect(find.byKey(const Key('applicant_a2')), findsOneWidget);
    expect(server.onboardingState, 'complete');
    expect(h.auth.signOutCalls, 0);
  });

  testWidgets('returning complete user lands on the dashboard without any onboarding screen', (tester) async {
    final server = FakeServer()
      ..legalPending = false
      ..declared = 1
      ..onboardingState = 'complete';
    server.applicants.add({
      ...((fixture('applicants_list')['applicants'] as List).first as Map<String, dynamic>),
      'id': 'a9',
    });
    await pumpApp(tester, server, user: const AuthUser(uid: 'u1'));
    expect(text('Your family'), findsOneWidget);
    expect(find.byKey(const Key('applicant_a9')), findsOneWidget);
    expect(server.log.where((r) => r.path == '/v1/auth/session'), isEmpty); // cold start uses /me
    expect(find.byKey(const Key('readOnlyBanner')), findsNothing);
    expect(find.byKey(const Key('nullaDays')), findsOneWidget);
  });

  testWidgets('a read-only (grace) applicant shows the banner; write affordances follow canWrite', (tester) async {
    final server = FakeServer(canWrite: false)
      ..legalPending = false
      ..declared = 1
      ..onboardingState = 'complete';
    final a = ((fixture('applicants_list')['applicants'] as List).first as Map<String, dynamic>);
    a['access'] = {'level': 'grace_read_only', 'canWrite': false, 'accessUntil': null, 'graceUntil': null};
    server.applicants.add(a);
    await pumpApp(tester, server, user: const AuthUser(uid: 'u1'));
    expect(find.byKey(const Key('readOnlyBanner')), findsOneWidget);
    expect(text('Your access is in its read-only grace period.'), findsOneWidget);
  });

  testWidgets('an applicant whose case is not generated yet says so instead of showing 0%', (tester) async {
    final server = FakeServer()
      ..legalPending = false
      ..declared = 1
      ..onboardingState = 'complete';
    final a = ((fixture('applicants_list')['applicants'] as List).first as Map<String, dynamic>);
    a['caseGeneratedAt'] = null;
    server.applicants.add(a);
    await pumpApp(tester, server, user: const AuthUser(uid: 'u1'));
    expect(text('Your checklist is being prepared.'), findsOneWidget);
  });

  testWidgets('login failure shows a readable message from the failure REASON', (tester) async {
    final server = FakeServer();
    final h = await pumpApp(tester, server);
    h.auth.failNext = const AuthFailure(AuthFailureReason.invalidCredentials);
    await tester.enterText(find.byKey(const Key('email')), 'a@b.co');
    await tester.enterText(find.byKey(const Key('password')), 'wrong-password');
    await tester.tap(find.byKey(const Key('submit')));
    await tester.pumpAndSettle();
    expect(text('Email or password is incorrect.'), findsOneWidget);
    expect(find.byKey(const Key('submit')), findsOneWidget); // still on Login
  });

  testWidgets('client-side validation blocks a bad email / short password before any call', (tester) async {
    final server = FakeServer();
    await pumpApp(tester, server);
    await tester.enterText(find.byKey(const Key('email')), 'nope');
    await tester.enterText(find.byKey(const Key('password')), 'short');
    await tester.tap(find.byKey(const Key('submit')));
    await tester.pumpAndSettle();
    expect(text('Enter a valid email address.'), findsOneWidget);
    expect(text('Use at least 8 characters.'), findsOneWidget);
    expect(server.log, isEmpty);
  });

  testWidgets('evicted device: terminal code on /me signs out and Login explains why', (tester) async {
    final server = FakeServer()..legalPending = false..onboardingState = 'complete';
    server.failures['GET /v1/me'] = reply(401, errorBody(ApiCodes.deviceEvicted));
    final h = await pumpApp(tester, server, user: const AuthUser(uid: 'u1'));
    expect(h.auth.signOutCalls, 1);
    expect(find.byKey(const Key('signOutNotice')), findsOneWidget);
    expect(text('You were signed out because this account reached its device limit.'), findsOneWidget);
  });

  testWidgets('offline cold start: Splash shows an error and Try again recovers', (tester) async {
    final server = FakeServer()..legalPending = false..onboardingState = 'complete';
    var online = false;
    final h = harness((o) => online ? server.handle(o) : reply(0), user: const AuthUser(uid: 'u1'));
    tester.view.physicalSize = const Size(800, 1800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(ProviderScope(retry: (_, _) => null, overrides: h.overrides.cast(), child: const VisaItalyApp()));
    await tester.pumpAndSettle();
    expect(text("We couldn't load your account."), findsOneWidget);
    expect(text('No connection. Check your internet and try again.'), findsOneWidget);
    online = true;
    await tester.tap(text('Try again'));
    await tester.pumpAndSettle();
    expect(text('Your family'), findsOneWidget);
  });

  testWidgets('applicant limit reached shows the limit message, not a crash', (tester) async {
    final server = FakeServer()..legalPending = false..declared = 2..onboardingState = 'applicants_pending';
    server.failures['POST /v1/applicants'] = reply(409, errorBody(ApiCodes.applicantLimitReached));
    await pumpApp(tester, server, user: const AuthUser(uid: 'u1'));
    await addApplicant(tester, name: 'Ayesha', relationship: 'Wife');
    expect(find.byKey(const Key('formError')), findsOneWidget);
    expect(text('You have reached the maximum number of applicants.'), findsOneWidget);
  });

  testWidgets('legal version published while the gate was open: reload and ask again', (tester) async {
    final server = FakeServer();
    server.failures['POST /v1/legal/accept'] = reply(422, errorBody(ApiCodes.validationFailed));
    final h = await pumpApp(tester, server, user: const AuthUser(uid: 'u1'));
    expect(h.auth.signOutCalls, 0);
    await tester.tap(find.byKey(const Key('legalCheck')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('legalAccept')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('legalChanged')), findsOneWidget);
    expect(server.log.where((r) => r.path == '/v1/legal/current'), hasLength(2)); // reloaded
  });
}
