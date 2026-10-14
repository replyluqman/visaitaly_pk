import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/app/app.dart';
import 'package:visaitaly_pk/app/router.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/providers.dart';
import 'package:visaitaly_pk/core/session/session_state.dart';

import '../helpers/fake_server.dart';
import '../helpers/harness.dart';

void main() {
  testWidgets('registration refused with APP_UPDATE_REQUIRED: update screen, user stays signed in, Play link opens', (tester) async {
    tester.view.physicalSize = const Size(800, 1800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final server = FakeServer()..minAppVersion = '2.0.0'; // the test app is 1.0.0
    final h = harness(server.handle);
    final opened = <Uri>[];
    await tester.pumpWidget(ProviderScope(
      retry: (_, _) => null,
      overrides: [...h.overrides.cast(), urlOpenerProvider.overrideWithValue((u) async {
        opened.add(u);
        return true;
      })],
      child: const VisaItalyApp(),
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('email')), 'old@example.com');
    await tester.enterText(find.byKey(const Key('password')), 'correct horse');
    await tester.tap(find.byKey(const Key('submit')));
    await tester.pumpAndSettle();

    expect(find.text('Update needed'), findsOneWidget);
    expect(h.auth.signOutCalls, 0); // an outdated build is not a logout
    await tester.tap(find.byKey(const Key('updateButton')));
    await tester.pumpAndSettle();
    expect(opened.single.toString(), 'market://details?id=pk.visaitaly.app');
  });

  testWidgets('a failed Play Store launch tells the user what to do', (tester) async {
    tester.view.physicalSize = const Size(800, 1800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final server = FakeServer()..minAppVersion = '2.0.0';
    final h = harness(server.handle);
    await tester.pumpWidget(ProviderScope(
      retry: (_, _) => null,
      overrides: [...h.overrides.cast(), urlOpenerProvider.overrideWithValue((_) async => false)],
      child: const VisaItalyApp(),
    ));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('email')), 'old@example.com');
    await tester.enterText(find.byKey(const Key('password')), 'correct horse');
    await tester.tap(find.byKey(const Key('submit')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('updateButton')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('updateFailed')), findsOneWidget);
  });

  test('a cold-start /me whose minAppVersion is above this build → SessionUpdateRequired (the running-app half of the gate)', () async {
    final server = FakeServer()
      ..legalPending = false
      ..onboardingState = 'complete'
      ..minAppVersion = '1.0.1'; // app is 1.0.0
    final h = harness(server.handle, user: const AuthUser(uid: 'u1'));
    final c = h.container();
    addTearDown(c.dispose);
    c.read(sessionControllerProvider);
    await Future<void>.delayed(const Duration(milliseconds: 150));
    final s = c.read(sessionControllerProvider);
    expect(s, isA<SessionUpdateRequired>());
    expect((s as SessionUpdateRequired).minVersion, '1.0.1');
    expect(h.auth.signOutCalls, 0);
    // once the server lowers the bar (or the user updates), a refresh recovers
    server.minAppVersion = '1.0.0';
    await c.read(sessionControllerProvider.notifier).refresh();
    expect(c.read(sessionControllerProvider), isA<SessionReady>());
  });

  test('router: update-required pins to /update from anywhere', () {
    const s = SessionUpdateRequired('2.0.0');
    for (final p in [Routes.home, Routes.login, Routes.legal, Routes.splash]) {
      expect(computeRedirect(s, p), Routes.update, reason: p);
    }
    expect(computeRedirect(s, Routes.update), isNull);
  });
}
