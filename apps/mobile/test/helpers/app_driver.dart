import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:visaitaly_pk/app/app.dart';
import 'package:visaitaly_pk/app/router.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/file_picker_gateway.dart';
import 'package:visaitaly_pk/core/providers.dart';
import 'package:visaitaly_pk/core/settings_store.dart';

import 'fake_server.dart';
import 'fakes.dart';
import 'harness.dart';

class FakePicker implements FilePickerGateway {
  FakePicker(this.next);
  PickedFile? next;
  int calls = 0;
  bool lastImagesOnly = false;

  @override
  Future<PickedFile?> pick({bool imagesOnly = false}) async {
    calls++;
    lastImagesOnly = imagesOnly;
    return next;
  }
}

class Driver {
  Driver(this.tester, this.server, this.h, this.opened, this.picker);
  final WidgetTester tester;
  final FakeServer server;
  final Harness h;
  final List<Uri> opened;
  final FakePicker picker;

  GoRouter get router {
    final ctx = tester.element(find.byType(MaterialApp));
    return ProviderScope.containerOf(ctx).read(routerProvider);
  }

  Future<void> go(String location) async {
    router.go(location);
    await tester.pumpAndSettle();
  }

  Future<void> push(String location) async {
    router.push(location);
    await tester.pumpAndSettle();
  }

  Future<void> tap(Finder f) async {
    await tester.ensureVisible(f);
    await tester.tap(f);
    await tester.pumpAndSettle();
  }

  Iterable<RequestLog> logs(String method, Pattern path) => server.log.where((r) => r.method == method && r.path.contains(path));
}

/// A signed-in, fully onboarded user with one applicant (case generated) unless told otherwise.
FakeServer completeServer({int applicants = 1, bool canWrite = true}) {
  final s = FakeServer(canWrite: canWrite)
    ..legalPending = false
    ..declared = applicants
    ..onboardingState = 'complete';
  final base = (fixture('applicants_list')['applicants'] as List).first as Map<String, dynamic>;
  for (var i = 0; i < applicants; i++) {
    s.applicants.add({
      ...base,
      'id': 'a${i + 1}',
      'displayName': i == 0 ? 'Ayesha' : 'Ali',
      if (!canWrite) 'access': {'level': 'grace_read_only', 'canWrite': false, 'accessUntil': null, 'graceUntil': null},
    });
  }
  return s;
}

Future<Driver> pumpSignedIn(
  WidgetTester tester,
  FakeServer server, {
  PickedFile? pick,
  Size size = const Size(800, 1800),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final h = harness(server.handle, user: const AuthUser(uid: 'u1'));
  final opened = <Uri>[];
  final picker = FakePicker(pick);
  await tester.pumpWidget(ProviderScope(
    retry: (_, _) => null,
    overrides: [
      ...h.overrides.cast(),
      filePickerProvider.overrideWithValue(picker),
      urlOpenerProvider.overrideWithValue((u) async {
        opened.add(u);
        return true;
      }),
    ],
    child: const VisaItalyApp(),
  ));
  await tester.pumpAndSettle();
  return Driver(tester, server, h, opened, picker);
}

Future<Driver> pumpSignedOut(WidgetTester tester, FakeServer server, {bool firstOpen = false}) async {
  tester.view.physicalSize = const Size(800, 1800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final h = harness(server.handle);
  final opened = <Uri>[];
  final picker = FakePicker(null);
  await tester.pumpWidget(ProviderScope(
    retry: (_, _) => null,
    overrides: [
      ...h.overrides.cast(),
      settingsStoreProvider.overrideWithValue(MemorySettingsStore(seenQuickCheck: !firstOpen)),
      urlOpenerProvider.overrideWithValue((u) async {
        opened.add(u);
        return true;
      }),
    ],
    child: const VisaItalyApp(),
  ));
  await tester.pumpAndSettle();
  return Driver(tester, server, h, opened, picker);
}
