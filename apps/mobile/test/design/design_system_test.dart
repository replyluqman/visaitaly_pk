import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/design/components.dart';
import 'package:visaitaly_pk/core/design/glass_surface.dart';
import 'package:visaitaly_pk/core/design/perf_tier.dart';
import 'package:visaitaly_pk/core/design/theme.dart';
import 'package:visaitaly_pk/core/design/tokens.dart';
import 'package:visaitaly_pk/core/l10n/app_localizations.dart';
import 'package:visaitaly_pk/core/models/enums.dart';

double _lum(Color c) {
  double f(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

double contrast(Color a, Color b) {
  final la = _lum(a), lb = _lum(b);
  return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
}

/// Composite [top] (with its alpha) over an opaque [bottom].
Color over(Color top, Color bottom) => Color.alphaBlend(top, bottom);

Widget host(Widget child, {PerfTier? tier, Brightness b = Brightness.light, double scale = 1}) => ProviderScope(
      key: ValueKey(tier),
      overrides: [if (tier != null) deviceFactsProvider.overrideWithValue(_factsFor(tier))],
      child: MaterialApp(
        theme: buildTheme(b),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        builder: (c, w) => MediaQuery(data: MediaQuery.of(c).copyWith(textScaler: TextScaler.linear(scale)), child: w!),
        home: Scaffold(body: Center(child: child)),
      ),
    );

DeviceFacts _factsFor(PerfTier t) => switch (t) {
      PerfTier.full => const DeviceFacts(ramMb: 6000, sdkInt: 34),
      PerfTier.lite => const DeviceFacts(ramMb: 2000, sdkInt: 28),
      PerfTier.solid => const DeviceFacts(ramMb: 6000, sdkInt: 34, reduceMotion: true),
    };

void main() {
  group('tokens: contrast (DESIGN-SYSTEM.md §2)', () {
    for (final entry in {'light': VipPalette.light, 'dark': VipPalette.dark}.entries) {
      final p = entry.value;
      test('${entry.key}: primary text ≥ 7:1 and secondary ≥ 4.5:1 on the list-card tint', () {
        final card = over(p.surfaceTint, p.bgBase);
        expect(contrast(p.textPrimary, card), greaterThanOrEqualTo(7), reason: 'primary');
        expect(contrast(p.textSecondary, card), greaterThanOrEqualTo(4.5), reason: 'secondary');
      });
      test('${entry.key}: every status colour reads on the card (≥ 3:1, large/icon threshold) except the deliberately muted N/A', () {
        final card = over(p.surfaceTint, p.bgBase);
        for (final c in [p.statusNotStarted, p.statusInProgress, p.statusReady, p.statusIssueFound, p.badgeBlocking, p.badgeNeedsReview, p.badgeSourceUnderReview]) {
          expect(contrast(c, card), greaterThanOrEqualTo(3), reason: c.toString());
        }
      });
      test('${entry.key}: primary action text on lagoon is readable (≥ 4.5:1)', () {
        expect(contrast(p.textOnBrand, p.lagoon), greaterThanOrEqualTo(4.5));
      });
    }
  });

  group('performance tier (§4)', () {
    test('full needs ≥ 4 GB and Android 10+; a 4 GB phone that reports 3.7 GB still counts', () {
      expect(decideTier(const DeviceFacts(ramMb: 6000, sdkInt: 34)), PerfTier.full);
      expect(decideTier(const DeviceFacts(ramMb: 3800, sdkInt: 30)), PerfTier.full);
      expect(decideTier(const DeviceFacts(ramMb: 3000, sdkInt: 34)), PerfTier.lite);
      expect(decideTier(const DeviceFacts(ramMb: 8000, sdkInt: 28)), PerfTier.lite);
    });
    test('unknown facts degrade to lite, never full; reduce-motion / high-contrast → solid', () {
      expect(decideTier(const DeviceFacts()), PerfTier.lite);
      expect(decideTier(const DeviceFacts(ramMb: 8000, sdkInt: 34, reduceMotion: true)), PerfTier.solid);
      expect(decideTier(const DeviceFacts(ramMb: 8000, sdkInt: 34, highContrast: true)), PerfTier.solid);
    });
    test('frame monitor fires once when > 10% of 120 frames are over 16 ms, and not otherwise', () {
      var fired = 0;
      final m = FrameDropMonitor(onDowngrade: () => fired++);
      m.addDurationsMs(List.filled(120, 10)); // smooth
      expect(fired, 0);
      m.addDurationsMs([...List.filled(100, 10), ...List.filled(20, 40)]); // 16% slow
      expect(fired, 1);
      m.addDurationsMs(List.filled(500, 50)); // already downgraded: no repeat
      expect(fired, 1);
    });
    test('the controller only ever lowers the tier; the user setting forces solid and can be undone', () {
      final c = ProviderContainer(overrides: [deviceFactsProvider.overrideWithValue(const DeviceFacts(ramMb: 6000, sdkInt: 34))]);
      addTearDown(c.dispose);
      final n = c.read(perfTierProvider.notifier);
      expect(c.read(perfTierProvider), PerfTier.full);
      n.downgradeToLite();
      expect(c.read(perfTierProvider), PerfTier.lite);
      n.setUserReduced(true);
      expect(c.read(perfTierProvider), PerfTier.solid);
      n.setUserReduced(false);
      expect(c.read(perfTierProvider), PerfTier.lite); // back to the (downgraded) detected tier, not full
    });
  });

  group('GlassSurface', () {
    testWidgets('blur ONLY on the full tier, and never when strong', (tester) async {
      Future<int> blurCount(PerfTier t, {bool strong = false}) async {
        await tester.pumpWidget(host(GlassSurface(strong: strong, child: const Text('x')), tier: t));
        await tester.pumpAndSettle();
        return find.descendant(of: find.byType(GlassSurface), matching: find.byType(BackdropFilter)).evaluate().length;
      }

      expect(await blurCount(PerfTier.full), 1);
      expect(await blurCount(PerfTier.full, strong: true), 0);
      expect(await blurCount(PerfTier.lite), 0);
      expect(await blurCount(PerfTier.solid), 0);
    });

    test('no screen creates a BackdropFilter itself — only GlassSurface (lint)', () {
      final offenders = <String>[];
      for (final f in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'))) {
        if (f.path.endsWith('core/design/glass_surface.dart')) continue;
        final code = f.readAsLinesSync().where((l) => !l.trimLeft().startsWith('//'));
        if (code.any((l) => l.contains('BackdropFilter'))) offenders.add(f.path);
      }
      expect(offenders, isEmpty);
    });
  });

  group('components', () {
    testWidgets('every status shows icon + label, not colour alone', (tester) async {
      for (final s in [ItemStatus.notStarted, ItemStatus.inProgress, ItemStatus.ready, ItemStatus.issueFound, ItemStatus.notApplicable]) {
        await tester.pumpWidget(host(StatusChip(s)));
        expect(find.byType(Icon), findsOneWidget, reason: s.name);
        expect(find.byType(Text), findsOneWidget, reason: s.name);
      }
      await tester.pumpWidget(host(const StatusChip(ItemStatus.issueFound)));
      expect(find.text('Issue found'), findsOneWidget);
    });

    testWidgets('badges carry the locked copy', (tester) async {
      await tester.pumpWidget(host(const Column(children: [BadgePill(ItemBadge.blocking), BadgePill(ItemBadge.needsReview), BadgePill(ItemBadge.sourceUnderReview)])));
      expect(find.text('Blocking submission'), findsOneWidget);
      expect(find.text('Needs review'), findsOneWidget);
      expect(find.text('Source updated — under review'), findsOneWidget);
    });

    testWidgets('VerifiedStamp: "Verified 12 days ago", amber only beyond the configured threshold, never-verified is amber', (tester) async {
      final now = DateTime.utc(2026, 10, 14);
      Future<void> pump(DateTime? at, int stale) => tester.pumpWidget(host(VerifiedStamp(lastVerifiedAt: at, staleAfterDays: stale, now: now)));
      Color iconColor() => tester.widget<Icon>(find.byType(Icon)).color!;

      await pump(now.subtract(const Duration(days: 12)), 30);
      expect(find.text('Verified 12 days ago'), findsOneWidget);
      expect(iconColor(), VipPalette.light.statusReady);
      await pump(now.subtract(const Duration(days: 31)), 30);
      expect(iconColor(), VipPalette.light.badgeNeedsReview);
      await pump(now.subtract(const Duration(days: 30)), 30);
      expect(iconColor(), VipPalette.light.statusReady); // exactly at the threshold is not yet stale
      await pump(now, 30);
      expect(find.text('Verified today'), findsOneWidget);
      await pump(now.subtract(const Duration(days: 1)), 30);
      expect(find.text('Verified 1 day ago'), findsOneWidget);
      await pump(null, 30);
      expect(find.text('Not verified yet'), findsOneWidget);
      expect(iconColor(), VipPalette.light.badgeNeedsReview);
    });

    testWidgets('readiness announces percent and blockers to TalkBack', (tester) async {
      final h = tester.ensureSemantics();
      await tester.pumpWidget(host(const ReadinessBar(percent: 68, blocking: 4)));
      expect(find.bySemanticsLabel('68 percent ready, 4 items blocking submission'), findsOneWidget);
      await tester.pumpWidget(host(const ReadinessRing(percent: 100, blocking: 0)));
      expect(find.bySemanticsLabel('100 percent ready, nothing blocking'), findsOneWidget);
      h.dispose();
    });

    testWidgets('layouts do not overflow at the 1.3× font scale', (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 640));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(host(
        Column(mainAxisSize: MainAxisSize.min, children: [
          const BadgePill(ItemBadge.sourceUnderReview),
          const StatusChip(ItemStatus.issueFound),
          VerifiedStamp(lastVerifiedAt: null, staleAfterDays: 30, now: _epoch),
        ]),
        scale: 1.3,
      ));
      expect(tester.takeException(), isNull);
    });
  });
}

final _epoch = DateTime.utc(2026, 10, 14);
