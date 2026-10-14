import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/glass_surface.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/providers.dart';
import '../../../core/ui/app_bar.dart';
import '../../../core/ui/error_text.dart';
import '../../../core/ui/format.dart';
import '../data/dto/public_dto.dart';

final verificationSummaryProvider = FutureProvider.autoDispose<VerificationSummary>(
  (ref) => ref.watch(publicRepositoryProvider).verificationSummary(),
);

/// Screen 15 — the price justification: how verification works, live aggregate stats, recent updates.
/// No account is needed to read it (it is reachable from the paywall).
class VerifyScreen extends ConsumerWidget {
  const VerifyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final locale = Localizations.localeOf(context).toLanguageTag();
    final s = ref.watch(verificationSummaryProvider);

    return Scaffold(
      appBar: GlassAppBar(title: l.verifyTitle),
      body: ListView(padding: const EdgeInsets.all(Sp.gutter), children: [
        Text(l.verifyIntro, style: VipType.body),
        const SizedBox(height: Sp.l),
        for (final t in [l.verifyPoint1, l.verifyPoint2, l.verifyPoint3, l.verifyPoint4])
          Padding(
            padding: const EdgeInsets.only(bottom: Sp.s),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Icon(Icons.check_circle_outline, size: 18, color: p.lagoon),
              const SizedBox(width: Sp.s),
              Expanded(child: Text(t)),
            ]),
          ),
        const SizedBox(height: Sp.l),
        s.when(
          loading: () => const Center(child: Padding(padding: EdgeInsets.all(Sp.xl), child: CircularProgressIndicator())),
          error: (e, _) => Column(children: [
            Text(errorText(l, e)),
            TextButton(onPressed: () => ref.invalidate(verificationSummaryProvider), child: Text(l.commonRetry)),
          ]),
          data: (v) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            GlassSurface(
              strong: true,
              padding: const EdgeInsets.all(Sp.l),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(l.verifyTracked(v.requirementsTracked), key: const Key('verifyTracked'), style: VipType.headline),
                Text(l.verifyLinked(v.sourceLinkedPercent.round()), key: const Key('verifyLinked')),
                Text(v.lastSweepAt == null ? l.verifyNoSweep : l.verifyLastSweep(formatInstant(v.lastSweepAt, locale)), key: const Key('verifySweep')),
                Text(l.verifyFlags(v.openFlags), key: const Key('verifyFlags')),
              ]),
            ),
            const SizedBox(height: Sp.l),
            Text(l.verifyRecent, style: VipType.headline),
            const SizedBox(height: Sp.s),
            if (v.recentUpdates.isEmpty) Text(l.verifyNoRecent, key: const Key('verifyNoRecent')),
            for (final u in v.recentUpdates)
              Card(
                child: ListTile(
                  title: Text(u.requirementTitle),
                  subtitle: Text([if (u.changeSummary != null) u.changeSummary!, l.verifyEffective(formatYmd(u.effectiveDate, locale))].join('\n')),
                  isThreeLine: u.changeSummary != null,
                ),
              ),
          ]),
        ),
      ]),
    );
  }
}
