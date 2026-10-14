import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/app/app.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/design/perf_tier.dart';
import 'package:visaitaly_pk/core/providers.dart';
import 'package:visaitaly_pk/core/settings_store.dart';

import '../helpers/app_driver.dart';
import '../helpers/fake_server.dart';
import '../helpers/fakes.dart';
import '../helpers/harness.dart';

/// Renders the real screens (real theme, real widgets, fixture-shaped data) to PNG files so the design can be
/// reviewed without a phone:
///
///   SCREENSHOT_DIR=../../docs/design/screenshots flutter test test/screenshots
///
/// The data below is ILLUSTRATIVE (invented titles and numbers) — it is never sent anywhere or shipped.
/// Skipped in the normal suite.
final _dir = Platform.environment['SCREENSHOT_DIR'];
final _shotKey = GlobalKey(debugLabel: 'shot');

Future<void> _loadFonts() async {
  final inter = FontLoader('Inter')..addFont(rootBundle.load('assets/fonts/InterVariable.ttf'));
  await inter.load();
  final flutterBin = File(Platform.resolvedExecutable).parent; // …/bin/cache/artifacts/engine/linux-x64 → find the SDK
  Directory d = flutterBin;
  File? icons;
  for (var i = 0; i < 8 && icons == null; i++) {
    final c = File('${d.path}/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
    final c2 = File('${d.path}/artifacts/material_fonts/MaterialIcons-Regular.otf');
    if (c.existsSync()) icons = c;
    if (c2.existsSync()) icons = c2;
    d = d.parent;
  }
  if (icons != null) {
    final loader = FontLoader('MaterialIcons')..addFont(Future.value(ByteData.view(icons.readAsBytesSync().buffer)));
    await loader.load();
  }
}

Future<void> _shot(WidgetTester tester, String name) async {
  await tester.pumpAndSettle();
  final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(_shotKey));
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 1);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    Directory(_dir!).createSync(recursive: true);
    File('$_dir/$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
  });
}

// ---- illustrative data -------------------------------------------------------------------------------------------

Map<String, dynamic> _applicant(String id, String name, String rel, String cat, {int pct = 0, int blocking = 0, int applicable = 0, int na = 0, int specific = 0, String stage = 'documents', String nulla = 'received', int? days = 110, bool canWrite = true}) => {
      'id': id, 'displayName': name, 'relationshipCode': rel, 'relationshipLabel': rel == 'wife' ? 'Spouse' : 'Child', 'relationshipCategory': cat,
      'dateOfBirth': null, 'currentLocation': 'pakistan', 'currentStage': stage, 'stageUpdatedAt': '2026-10-01T08:00:00.000Z', 'caseGeneratedAt': '2026-10-01T08:00:00.000Z',
      'nullaOsta': {'status': nulla, 'issueDate': '2026-08-01', 'expiryDate': '2027-02-01', 'daysRemaining': days},
      'access': {'level': canWrite ? 'premium' : 'grace_read_only', 'canWrite': canWrite, 'accessUntil': null, 'graceUntil': null},
      'readiness': {'percent': pct, 'applicableCount': applicable, 'readyCount': (applicable * pct / 100).round(), 'blockingCount': blocking, 'notApplicableCount': na, 'categorySpecificCount': specific},
      'createdAt': '2026-10-01T08:00:00.000Z',
    };

Map<String, dynamic> _item(String id, String title, String status, {List<String> badges = const [], String stage = 'documents', bool translation = false, bool apostille = false, String? na, int docs = 0, String verified = '2026-10-02T10:00:00.000Z'}) => {
      'id': id, 'requirementCode': id, 'stage': stage, 'title': title, 'status': status, 'badges': badges, 'notApplicableReason': na,
      'translationRequired': translation, 'apostilleRequired': apostille, 'lastVerifiedAt': verified, 'requirementVersion': 2, 'documentCount': docs, 'updatedAt': '2026-10-10T10:00:00.000Z',
    };

FakeServer _server({bool free = false}) {
  final s = FakeServer()
    ..legalPending = false
    ..declared = 2
    ..onboardingState = 'complete';
  s.applicants.addAll([
    _applicant('a1', 'Ayesha', 'wife', 'spouse', pct: 68, blocking: 4, applicable: 22, na: 2, specific: 5),
    _applicant('a2', 'Ali', 'son', 'child', pct: 31, blocking: 2, applicable: 16, na: 4, specific: 3, stage: 'nulla_osta', nulla: 'in_process', days: null),
  ]);
  final items = [
    _item('i1', 'Valid passport (6+ months)', 'ready', badges: [], stage: 'eligibility', docs: 1),
    _item('i2', 'Marriage certificate (Nikah nama)', 'in_progress', badges: ['blocking'], translation: true, apostille: true, docs: 1),
    _item('i3', 'Sponsor’s residence permit', 'issue_found', badges: ['blocking', 'source_under_review']),
    _item('i4', 'Proof of accommodation', 'not_started', badges: ['blocking'], translation: true),
    _item('i5', 'Recent passport photographs', 'not_started'),
    _item('i6', 'Parental consent (applies to minors)', 'not_applicable', na: 'Required for the Child category — not applicable to your case.'),
  ];
  s.stub('~GET /v1/applicants/a1/checklist', free
      ? {'applicantId': 'a1', 'items': items.take(3).toList(), 'lockedCount': 19, 'nextCursor': null, 'syncedAt': '2026-10-14T12:00:00Z'}
      : {'applicantId': 'a1', 'items': items, 'lockedCount': 0, 'nextCursor': null, 'syncedAt': '2026-10-14T12:00:00Z'});
  s.stub('~GET /v1/checklist/.+', {
    ..._item('i2', 'Marriage certificate (Nikah nama)', 'in_progress', badges: ['blocking'], translation: true, apostille: true, docs: 1),
    'applicantId': 'a1',
    'purpose': 'Shows the relationship between you and your sponsor.',
    'whoProvides': 'The applicant, from the local union council.',
    'whereToObtain': 'Union council / NADRA, then attested as described by the official source.',
    'recommendedTiming': 'Start early — attestation can take several weeks.',
    'conditionNote': null,
    'source': {'name': 'Ministry of Foreign Affairs', 'url': 'https://example.test/source', 'document': 'Family reunification guidance', 'publishedAt': null},
    'documents': [
      {'id': 'd1', 'applicantId': 'a1', 'checklistItemId': 'i2', 'mime': 'image/jpeg', 'sizeBytes': 1843200, 'expiryDate': null, 'createdAt': '2026-10-09T09:30:00.000Z', 'viewUrl': null},
    ],
    'canWrite': true, 'staleAfterDays': 30,
  });
  s.stub('GET /v1/applicants/a1/journey', {
    'currentStage': 'documents',
    'stages': [
      {'stage': 'eligibility', 'state': 'done', 'itemCount': 3, 'readyCount': 3},
      {'stage': 'nulla_osta', 'state': 'done', 'itemCount': 2, 'readyCount': 2},
      {'stage': 'documents', 'state': 'current', 'itemCount': 9, 'readyCount': 4},
      {'stage': 'translation', 'state': 'upcoming', 'itemCount': 3, 'readyCount': 0},
      {'stage': 'appointment', 'state': 'upcoming', 'itemCount': 2, 'readyCount': 0},
      {'stage': 'application', 'state': 'upcoming', 'itemCount': 3, 'readyCount': 0},
      {'stage': 'processing', 'state': 'upcoming', 'itemCount': 0, 'readyCount': 0},
      {'stage': 'decision', 'state': 'upcoming', 'itemCount': 0, 'readyCount': 0},
    ],
  });
  s.stub('GET /v1/today', {
    'actions': [
      {'kind': 'expiring', 'reason': 'nulla_osta_expires', 'title': null, 'applicantId': 'a1', 'itemId': null, 'dueDate': '2027-02-01', 'deepLink': '/applicants/00000000-0000-4000-8000-000000000001'},
      {'kind': 'blocking', 'reason': 'blocks_submission', 'title': 'Marriage certificate (Nikah nama)', 'applicantId': 'a1', 'itemId': 'i2', 'dueDate': null, 'deepLink': '/checklist/00000000-0000-4000-8000-000000000002'},
      {'kind': 'blocking', 'reason': 'blocks_submission', 'title': 'Proof of accommodation', 'applicantId': 'a1', 'itemId': 'i4', 'dueDate': null, 'deepLink': '/checklist/00000000-0000-4000-8000-000000000003'},
      {'kind': 'todo', 'reason': 'issue_found', 'title': 'Sponsor’s residence permit', 'applicantId': 'a2', 'itemId': 'i3', 'dueDate': null, 'deepLink': '/checklist/00000000-0000-4000-8000-000000000004'},
    ],
    'allClear': null, 'computedAt': '2026-10-14T11:30:00Z',
  });
  s.stub('GET /v1/documents', {
    'items': [
      {'id': 'd1', 'applicantId': 'a1', 'checklistItemId': 'i2', 'mime': 'image/jpeg', 'sizeBytes': 1843200, 'expiryDate': null, 'createdAt': '2026-10-09T09:30:00.000Z', 'viewUrl': null},
      {'id': 'd2', 'applicantId': 'a1', 'checklistItemId': 'i1', 'mime': 'application/pdf', 'sizeBytes': 912000, 'expiryDate': '2029-05-20', 'createdAt': '2026-10-05T14:10:00.000Z', 'viewUrl': null},
      {'id': 'd3', 'applicantId': 'a2', 'checklistItemId': null, 'mime': 'image/png', 'sizeBytes': 402000, 'expiryDate': null, 'createdAt': '2026-10-03T08:00:00.000Z', 'viewUrl': null},
    ],
    'nextCursor': null, 'quota': {'usedBytes': 3157200, 'maxBytes': 524288000},
  });
  s.stub('GET /v1/notifications/unread-count', {'total': 2, 'byTab': {'reminder': 0, 'update': 1, 'activity': 1}});
  s.stubs['~GET /v1/notifications'] = (o) => reply(200, {
        'items': o.queryParameters['tab'] == 'update'
            ? [
                {'id': 'n1', 'tab': 'update', 'type': 'requirement_changed', 'title': 'A requirement changed', 'body': 'Marriage certificate (Nikah nama): attestation steps were updated. Changed 3 days ago. This affects your case.', 'deepLink': '/applicants/00000000-0000-4000-8000-000000000001', 'applicantId': 'a1', 'createdAt': '2026-10-11T08:00:00Z', 'readAt': null},
                {'id': 'n2', 'tab': 'update', 'type': 'requirement_added', 'title': 'New requirement added', 'body': 'Proof of accommodation was added for the Spouse category.', 'deepLink': '/applicants/00000000-0000-4000-8000-000000000001', 'applicantId': 'a1', 'createdAt': '2026-10-02T08:00:00Z', 'readAt': '2026-10-03T08:00:00Z'},
              ]
            : [],
        'nextCursor': null,
      });
  s.stub('GET /v1/support/thread', {'status': 'awaiting_support', 'tier': 'paid', 'slaDueAt': '2026-10-15T09:00:00Z', 'unreadCount': 0, 'workingHoursText': 'Mon–Sat, 9:00–18:00 (Pakistan time)', 'allowedTopics': ['payment', 'order', 'courier', 'refund', 'account', 'app_problem', 'presales']});
  s.stub('GET /v1/support/messages', {
    'items': [
      {'id': 'm2', 'senderType': 'user', 'body': 'Hello, can you tell me how long attestation usually takes?', 'topic': 'presales', 'applicantId': null, 'attachment': null, 'createdAt': '2026-10-14T10:05:00Z', 'readByUserAt': '2026-10-14T10:05:00Z'},
      {'id': 'm1', 'senderType': 'admin', 'body': 'Hi! Details for Marriage certificate (Nikah nama): /checklist — see the official source linked there. Verified 12 days ago.', 'topic': 'presales', 'applicantId': null, 'attachment': null, 'createdAt': '2026-10-13T15:00:00Z', 'readByUserAt': '2026-10-13T15:10:00Z'},
    ],
    'nextCursor': null,
  });
  s.stub('POST /v1/support/read', null, status: 204);
  s.stub('GET /v1/account/consents', {'analytics': true, 'crashReports': true, 'marketingPush': false, 'policyVersion': '1.0', 'answered': true});
  s.stub('GET /v1/devices', {'devices': [
    {'deviceId': '11111111-1111-4111-8111-111111111111', 'platform': 'android', 'model': 'Pixel 7', 'appVersion': '1.0.0', 'lastLoginAt': '2026-10-14T09:00:00Z', 'lastSeenAt': '2026-10-14T11:58:00Z', 'isCurrent': true},
    {'deviceId': '22222222-2222-4222-8222-222222222222', 'platform': 'android', 'model': 'Galaxy A14', 'appVersion': '1.0.0', 'lastLoginAt': '2026-10-10T09:00:00Z', 'lastSeenAt': '2026-10-12T18:20:00Z', 'isCurrent': false},
  ]});
  s.stub('GET /v1/notification-preferences', {'push': {'reminder': true, 'update': true, 'activity': false}});
  s.stub('GET /v1/legal/current', {'documents': [
    {'id': 'v1', 'docType': 'disclaimer', 'locale': 'en', 'version': '1.0', 'title': 'Disclaimer', 'isMandatory': true, 'publishedAt': null, 'accepted': true},
    {'id': 'v2', 'docType': 'privacy', 'locale': 'en', 'version': '1.0', 'title': 'Privacy Policy', 'isMandatory': true, 'publishedAt': null, 'accepted': true},
  ], 'requiresAcceptance': false});
  s.stub('GET /v1/public/verification-summary', {
    'requirementsTracked': 48, 'sourceLinkedPercent': 100, 'lastSweepAt': '2026-10-14T03:00:00Z', 'openFlags': 1,
    'recentUpdates': [
      {'requirementTitle': 'Marriage certificate (Nikah nama)', 'changeSummary': 'Attestation steps updated', 'effectiveDate': '2026-10-11'},
      {'requirementTitle': 'Proof of accommodation', 'changeSummary': 'Added for the Spouse category', 'effectiveDate': '2026-10-02'},
    ],
  });
  return s;
}

Future<Driver> _pump(WidgetTester tester, FakeServer server, {Brightness b = Brightness.light, PerfTier tier = PerfTier.full, bool signedIn = true, bool firstOpen = false}) async {
  tester.view.physicalSize = const Size(1080, 2340); // a typical 6.1" Android at 3x → 360×780 dp
  tester.view.devicePixelRatio = 3;
  tester.platformDispatcher.platformBrightnessTestValue = b;
  addTearDown(() {
    tester.view.reset();
    tester.platformDispatcher.clearAllTestValues();
  });
  final h = harness(server.handle, user: signedIn ? const AuthUser(uid: 'u1') : null);
  final facts = switch (tier) {
    PerfTier.full => const DeviceFacts(ramMb: 6000, sdkInt: 34),
    PerfTier.lite => const DeviceFacts(ramMb: 2000, sdkInt: 28),
    PerfTier.solid => const DeviceFacts(ramMb: 6000, sdkInt: 34, reduceMotion: true),
  };
  final opened = <Uri>[];
  await tester.pumpWidget(RepaintBoundary(
    key: _shotKey,
    child: ProviderScope(
      retry: (_, _) => null,
      overrides: [
        ...h.overrides.cast(),
        deviceFactsProvider.overrideWithValue(facts),
        settingsStoreProvider.overrideWithValue(MemorySettingsStore(seenQuickCheck: !firstOpen)),
        urlOpenerProvider.overrideWithValue((u) async {
          opened.add(u);
          return true;
        }),
      ],
      child: const VisaItalyApp(),
    ),
  ));
  await tester.pumpAndSettle();
  return Driver(tester, server, h, opened, FakePicker(null));
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    if (_dir != null) await _loadFonts();
  });

  final bool? skip = _dir == null ? true : null; // skipped in the normal suite; set SCREENSHOT_DIR to render

  testWidgets('01 dashboard (light)', skip: skip, (tester) async {
    await _pump(tester, _server());
    await _shot(tester, '01-dashboard-light');
  });

  testWidgets('02 dashboard (dark)', skip: skip, (tester) async {
    await _pump(tester, _server(), b: Brightness.dark);
    await _shot(tester, '02-dashboard-dark');
  });

  testWidgets('03 dashboard (solid tier: reduce visual effects)', skip: skip, (tester) async {
    await _pump(tester, _server(), tier: PerfTier.solid);
    await _shot(tester, '03-dashboard-solid');
  });

  testWidgets('04 case view', skip: skip, (tester) async {
    final d = await _pump(tester, _server());
    await d.push('/applicants/a1');
    await _shot(tester, '04-case-view');
  });

  testWidgets('05 case view, free tier (locked rows)', skip: skip, (tester) async {
    final d = await _pump(tester, _server(free: true));
    await d.push('/applicants/a1');
    await tester.drag(find.byType(CustomScrollView), const Offset(0, -700));
    await _shot(tester, '05-case-view-free');
  });

  testWidgets('06 checklist item detail', skip: skip, (tester) async {
    final d = await _pump(tester, _server());
    await d.push('/checklist/i2');
    await _shot(tester, '06-item-detail');
  });

  testWidgets('07 item detail (dark)', skip: skip, (tester) async {
    final d = await _pump(tester, _server(), b: Brightness.dark);
    await d.push('/checklist/i2');
    await _shot(tester, '07-item-detail-dark');
  });

  testWidgets('08 journey', skip: skip, (tester) async {
    final d = await _pump(tester, _server());
    await d.push('/applicants/a1/journey');
    await _shot(tester, '08-journey');
  });

  testWidgets('09 today', skip: skip, (tester) async {
    final d = await _pump(tester, _server());
    await d.go('/today');
    await _shot(tester, '09-today');
  });

  testWidgets('10 my documents', skip: skip, (tester) async {
    final d = await _pump(tester, _server());
    await d.go('/documents');
    await _shot(tester, '10-documents');
  });

  testWidgets('11 notifications', skip: skip, (tester) async {
    final d = await _pump(tester, _server());
    await d.push('/notifications');
    await d.tap(find.byKey(const Key('tab_update')));
    await _shot(tester, '11-notifications');
  });

  testWidgets('12 support thread', skip: skip, (tester) async {
    final d = await _pump(tester, _server());
    await d.push('/support');
    await _shot(tester, '12-support');
  });

  testWidgets('13 account', skip: skip, (tester) async {
    final d = await _pump(tester, _server());
    await d.go('/account');
    await _shot(tester, '13-account');
  });

  testWidgets('14 how we verify', skip: skip, (tester) async {
    final d = await _pump(tester, _server());
    await d.push('/verify');
    await _shot(tester, '14-how-we-verify');
  });

  testWidgets('15 login', skip: skip, (tester) async {
    await _pump(tester, _server(), signedIn: false);
    await _shot(tester, '15-login');
  });

  testWidgets('16 quick check (pre-auth) result', skip: skip, (tester) async {
    final s = _server()
      ..stub('GET /v1/public/eligibility-check', {
        'version': 1, 'disclaimer': 'This is general orientation only. It is not legal advice and does not tell you whether an application will succeed.',
        'questions': [
          {'id': 'who', 'text': 'Who is the application for?', 'options': [{'value': 'spouse', 'label': 'Spouse'}, {'value': 'child', 'label': 'Child'}, {'value': 'parent', 'label': 'Parent'}]},
        ],
      })
      ..stub('POST /v1/public/eligibility-check', {
        'summary': 'Spouse applications typically involve the documents below.',
        'typicalItems': [
          {'title': 'Valid passport', 'why': 'Needed at every stage.'},
          {'title': 'Marriage certificate', 'why': 'Shows the relationship to your sponsor.'},
          {'title': 'Proof of accommodation', 'why': null},
        ],
        'lockedCount': 19, 'disclaimer': 'This is general orientation only. It is not legal advice and does not tell you whether an application will succeed.', 'whatsappUrl': 'https://wa.me/390000000000',
      });
    final d = await _pump(tester, s, signedIn: false, firstOpen: true);
    await d.tap(find.byKey(const Key('eligStart')));
    await d.tap(find.byKey(const Key('opt_spouse')));
    await d.tap(find.byKey(const Key('eligNext')));
    await _shot(tester, '16-quick-check-result');
  });
}
