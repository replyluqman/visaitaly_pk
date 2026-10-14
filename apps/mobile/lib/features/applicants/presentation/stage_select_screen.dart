import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/ui/error_text.dart';
import 'applicants_controller.dart';

/// Screen 7 — Current Stage Select, per applicant. Seeds the journey engine; the server generates the case in
/// the same transaction as the stage write, so the first dashboard view is never empty.
class StageSelectScreen extends ConsumerStatefulWidget {
  const StageSelectScreen({super.key});

  @override
  ConsumerState<StageSelectScreen> createState() => _StageSelectScreenState();
}

class _StageSelectScreenState extends ConsumerState<StageSelectScreen> {
  StageChoice? _choice;

  String _label(AppLocalizations l, StageChoice c) => switch (c) {
        StageChoice.planning => l.stagePlanning,
        StageChoice.nullaOstaInProcess => l.stageNoInProcess,
        StageChoice.nullaOstaReceived => l.stageNoReceived,
        StageChoice.documents => l.stageDocuments,
        StageChoice.appointment => l.stageAppointment,
        StageChoice.submitted => l.stageSubmitted,
        StageChoice.processing => l.stageProcessing,
        StageChoice.decision => l.stageDecision,
      };

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final list = ref.watch(applicantsProvider);
    final save = ref.watch(setStageControllerProvider);

    return PopScope(
      canPop: false,
      child: Scaffold(
        appBar: AppBar(title: Text(l.stageTitle), automaticallyImplyLeading: false),
        body: SafeArea(
          child: list.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(errorText(l, e)),
                FilledButton(onPressed: () => ref.invalidate(applicantsProvider), child: Text(l.commonRetry)),
              ]),
            ),
            data: (res) {
              // The first applicant whose stage has not been chosen yet (currentStage == null).
              final next = res.applicants.where((a) => a.currentStage == null).firstOrNull;
              if (next == null) return const Center(child: CircularProgressIndicator()); // router moves on after refresh
              return ListView(
                padding: const EdgeInsets.all(24),
                children: [
                  Text(l.stageSubtitle(next.displayName)),
                  const SizedBox(height: 8),
                  RadioGroup<StageChoice>(
                    groupValue: _choice,
                    onChanged: (v) => setState(() => _choice = v),
                    child: Column(children: [
                      for (final c in StageChoice.values)
                        RadioListTile<StageChoice>(key: Key('stage_${c.name}'), title: Text(_label(l, c)), value: c),
                    ]),
                  ),
                  if (save.hasError) Padding(padding: const EdgeInsets.only(top: 12), child: Text(errorText(l, save.error!), key: const Key('stageError'))),
                  const SizedBox(height: 16),
                  FilledButton(
                    key: const Key('stageContinue'),
                    onPressed: (_choice == null || save.isLoading)
                        ? null
                        : () async {
                            await ref.read(setStageControllerProvider.notifier).submit(next, _choice!);
                            if (mounted) setState(() => _choice = null);
                          },
                    child: Text(l.commonContinue),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}
