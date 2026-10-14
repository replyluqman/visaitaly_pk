import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/design/components.dart';
import '../../../core/design/glass_surface.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/ui/app_bar.dart';
import '../../../core/ui/error_text.dart';
import '../../../core/ui/labels.dart';
import '../../applicants/data/dto/applicant_dto.dart';
import '../../applicants/presentation/applicants_controller.dart';

/// Screen 8 — Family Dashboard. States: loading · error · empty · free/premium · read-only (grace/expired).
/// Write affordances follow `applicant.access.canWrite`; APPLICANT_READ_ONLY from the server is only the backstop.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final list = ref.watch(applicantsProvider);

    return Scaffold(
      appBar: GlassAppBar(title: l.homeTitle),
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(errorText(l, e), textAlign: TextAlign.center),
            const SizedBox(height: Sp.m),
            FilledButton(onPressed: () => ref.invalidate(applicantsProvider), child: Text(l.commonRetry)),
          ]),
        ),
        data: (res) {
          final withCase = res.applicants.where((a) => a.caseGeneratedAt != null).toList();
          return RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(applicantsProvider);
              await ref.read(applicantsProvider.future);
            },
            child: ListView(
              padding: const EdgeInsets.all(Sp.gutter),
              children: [
                if (withCase.length > 1) _Hero(applicants: withCase),
                const _QuickActions(),
                const SizedBox(height: Sp.m),
                if (res.applicants.isEmpty) Padding(padding: const EdgeInsets.all(Sp.xxl), child: Center(child: Text(l.homeEmpty))),
                for (final a in res.applicants) ...[
                  ApplicantCard(applicant: a, onTap: () => context.push(Routes.caseView(a.id))),
                  const SizedBox(height: Sp.s),
                ],
                const SizedBox(height: Sp.s),
                if (res.applicants.length < res.maxApplicants)
                  OutlinedButton.icon(
                    key: const Key('addApplicant'),
                    onPressed: () => context.push(Routes.addApplicant),
                    icon: const Icon(Icons.person_add_alt),
                    label: Text(l.homeAddApplicant),
                  )
                else
                  Text(l.homeLimit(res.maxApplicants), textAlign: TextAlign.center),
                const SizedBox(height: Sp.l),
                Text(l.homeDisclaimer, style: VipType.caption.copyWith(color: context.vip.textSecondary), textAlign: TextAlign.center),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// Combined readiness across applicants — the one blurred hero (blur 16) on the screen, outside any list.
class _Hero extends StatelessWidget {
  const _Hero({required this.applicants});
  final List<Applicant> applicants;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final ready = applicants.fold<int>(0, (s, a) => s + a.readiness.readyCount);
    final total = applicants.fold<int>(0, (s, a) => s + a.readiness.applicableCount);
    final blocking = applicants.fold<int>(0, (s, a) => s + a.readiness.blockingCount);
    final pct = total == 0 ? 0 : ready * 100 / total;
    return Padding(
      padding: const EdgeInsets.only(bottom: Sp.m),
      child: GlassSurface(
        key: const Key('hero'),
        blur: Blur.hero,
        radius: Rad.xl,
        padding: const EdgeInsets.all(Sp.l),
        child: Row(children: [
          ReadinessRing(percent: pct, blocking: blocking, size: 80),
          const SizedBox(width: Sp.l),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(l.homeHeroTitle, style: VipType.headline),
              Text(l.homeBlocking(blocking), style: VipType.body.copyWith(color: context.vip.textSecondary)),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _QuickActions extends StatelessWidget {
  const _QuickActions();

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    Widget action(Key k, IconData icon, String label, VoidCallback onTap) => Expanded(
          child: TintCard(
            key: k,
            onTap: onTap,
            padding: const EdgeInsets.symmetric(vertical: Sp.m, horizontal: Sp.s),
            child: Column(children: [
              Icon(icon),
              const SizedBox(height: Sp.xs),
              Text(label, style: VipType.caption, textAlign: TextAlign.center),
            ]),
          ),
        );
    return Row(children: [
      action(const Key('qaDocuments'), Icons.folder_outlined, l.homeQuickDocuments, () => context.go(Routes.documents)),
      const SizedBox(width: Sp.s),
      action(const Key('qaSupport'), Icons.chat_bubble_outline, l.homeQuickSupport, () => context.push(Routes.support)),
      const SizedBox(width: Sp.s),
      action(const Key('qaVerify'), Icons.verified_outlined, l.homeQuickVerify, () => context.push(Routes.verify)),
    ]);
  }
}

class ApplicantCard extends StatelessWidget {
  const ApplicantCard({required this.applicant, this.onTap, super.key});
  final Applicant applicant;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final a = applicant;
    final readOnly = !a.access.canWrite;
    final generated = a.caseGeneratedAt != null;
    final days = a.nullaOsta.daysRemaining;
    final nulla = switch (a.nullaOsta.status) {
      NullaOstaStatus.received => l.nullaPhraseReceived,
      NullaOstaStatus.inProcess => l.nullaPhraseInProcess,
      NullaOstaStatus.notStarted => l.nullaPhraseNotStarted,
      _ => null,
    };
    // Locked pattern: "Spouse · Nulla Osta received · 68% ready · 4 items blocking submission"
    final summary = [
      a.relationshipLabel,
      ?nulla,
      if (generated) l.homeReadiness(a.readiness.percent.round()),
      if (generated) l.homeBlocking(a.readiness.blockingCount),
    ].join(' · ');

    return TintCard(
      key: Key('applicant_${a.id}'),
      onTap: onTap,
      semanticLabel: '${a.displayName}, $summary',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(a.displayName, style: VipType.title)),
          if (generated) ReadinessRing(percent: a.readiness.percent, blocking: a.readiness.blockingCount, size: 52),
        ]),
        Text(summary, key: Key('summary_${a.id}'), style: VipType.body.copyWith(color: p.textSecondary)),
        Text(journeyLabel(l, a.currentStage), style: VipType.caption.copyWith(color: p.textSecondary)),
        const SizedBox(height: Sp.s),
        if (generated)
          ReadinessBar(percent: a.readiness.percent, blocking: a.readiness.blockingCount)
        else
          Text(l.homeCasePreparing),
        if (a.nullaOsta.status == NullaOstaStatus.received && days != null)
          Padding(
            padding: const EdgeInsets.only(top: Sp.xs),
            child: Text(days >= 0 ? l.homeNullaExpires(days) : l.homeNullaExpired(-days), key: const Key('nullaDays')),
          ),
        if (readOnly)
          Padding(
            padding: const EdgeInsets.only(top: Sp.s),
            child: Text(
              a.access.level == AccessLevel.graceReadOnly ? l.homeGraceBanner : l.homeReadOnlyBanner,
              key: const Key('readOnlyBanner'),
              style: TextStyle(color: p.statusIssueFound),
            ),
          ),
      ]),
    );
  }
}
