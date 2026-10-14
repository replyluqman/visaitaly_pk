import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/router.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/providers.dart';
import '../../../core/ui/error_text.dart';
import '../../applicants/data/dto/applicant_dto.dart';
import '../../applicants/presentation/applicants_controller.dart';

String journeyLabel(AppLocalizations l, JourneyStage? s) => switch (s) {
      JourneyStage.eligibility => l.journeyEligibility,
      JourneyStage.nullaOsta => l.journeyNullaOsta,
      JourneyStage.documents => l.journeyDocuments,
      JourneyStage.translation => l.journeyTranslation,
      JourneyStage.appointment => l.journeyAppointment,
      JourneyStage.application => l.journeyApplication,
      JourneyStage.processing => l.journeyProcessing,
      JourneyStage.decision => l.journeyDecision,
      _ => l.journeyUnknown,
    };

/// Screen 8 — Family Dashboard. States: loading · error · empty · free/premium · read-only (grace/expired).
/// Write affordances follow `applicant.access.canWrite`; APPLICANT_READ_ONLY from the server is only the backstop.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final list = ref.watch(applicantsProvider);

    return Scaffold(
      appBar: AppBar(
        title: Text(l.homeTitle),
        actions: [
          IconButton(
            key: const Key('signOut'),
            tooltip: l.homeSignOut,
            icon: const Icon(Icons.logout),
            onPressed: () => ref.read(sessionControllerProvider.notifier).signOut(),
          ),
        ],
      ),
      body: SafeArea(
        child: list.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(errorText(l, e), textAlign: TextAlign.center),
              const SizedBox(height: 12),
              FilledButton(onPressed: () => ref.invalidate(applicantsProvider), child: Text(l.commonRetry)),
            ]),
          ),
          data: (res) => RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(applicantsProvider);
              await ref.read(sessionControllerProvider.notifier).refresh();
              await ref.read(applicantsProvider.future);
            },
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                if (res.applicants.isEmpty) Padding(padding: const EdgeInsets.all(24), child: Center(child: Text(l.homeEmpty))),
                for (final a in res.applicants) ApplicantCard(applicant: a),
                const SizedBox(height: 8),
                if (res.applicants.length < res.maxApplicants)
                  OutlinedButton.icon(
                    key: const Key('addApplicant'),
                    onPressed: () => context.push(Routes.addApplicant),
                    icon: const Icon(Icons.person_add_alt),
                    label: Text(l.homeAddApplicant),
                  )
                else
                  Text(l.homeLimit(res.maxApplicants), textAlign: TextAlign.center),
                const SizedBox(height: 16),
                Text(l.homeDisclaimer, style: Theme.of(context).textTheme.bodySmall, textAlign: TextAlign.center),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class ApplicantCard extends StatelessWidget {
  const ApplicantCard({required this.applicant, super.key});
  final Applicant applicant;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final a = applicant;
    final readOnly = !a.access.canWrite;
    final generated = a.caseGeneratedAt != null;
    final days = a.nullaOsta.daysRemaining;

    return Card(
      key: Key('applicant_${a.id}'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(a.displayName, style: Theme.of(context).textTheme.titleMedium),
            Text('${a.relationshipLabel} · ${journeyLabel(l, a.currentStage)}'),
            const SizedBox(height: 8),
            if (generated) ...[
              LinearProgressIndicator(value: (a.readiness.percent / 100).clamp(0, 1).toDouble()),
              const SizedBox(height: 4),
              Text('${l.homeReadiness(a.readiness.percent.round())} · ${l.homeBlocking(a.readiness.blockingCount)}'),
            ] else
              Text(l.homeCasePreparing),
            if (a.nullaOsta.status == NullaOstaStatus.received && days != null)
              Text(days >= 0 ? l.homeNullaExpires(days) : l.homeNullaExpired(-days), key: const Key('nullaDays')),
            if (readOnly)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  a.access.level == AccessLevel.graceReadOnly ? l.homeGraceBanner : l.homeReadOnlyBanner,
                  key: const Key('readOnlyBanner'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
