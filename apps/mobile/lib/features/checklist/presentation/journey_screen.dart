import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/ui/app_bar.dart';
import '../../../core/ui/error_text.dart';
import '../../../core/ui/labels.dart';
import 'checklist_controller.dart';

/// Screen 12 — all eight stages, where the applicant is, what comes next. Counts only (free users may see it).
class JourneyScreen extends ConsumerWidget {
  const JourneyScreen({required this.applicantId, super.key});
  final String applicantId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final j = ref.watch(journeyProvider(applicantId));
    return Scaffold(
      appBar: GlassAppBar(title: l.journeyTitle),
      body: j.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(errorText(l, e)),
            FilledButton(onPressed: () => ref.invalidate(journeyProvider(applicantId)), child: Text(l.commonRetry)),
          ]),
        ),
        data: (res) => ListView.builder(
          padding: const EdgeInsets.all(Sp.gutter),
          itemCount: res.stages.length,
          itemBuilder: (_, i) {
            final s = res.stages[i];
            final (IconData icon, Color color, String tag) = switch (s.state) {
              StageState.done => (Icons.check_circle, p.statusReady, l.journeyDone),
              StageState.current => (Icons.radio_button_checked, p.lagoon, l.journeyCurrent),
              _ => (Icons.radio_button_unchecked, p.statusNotStarted, l.journeyUpcoming),
            };
            return IntrinsicHeight(
              child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Column(children: [
                  Icon(icon, color: color),
                  if (i < res.stages.length - 1) Expanded(child: Container(width: 2, color: p.strokeHairline)),
                ]),
                const SizedBox(width: Sp.m),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(bottom: Sp.l),
                    child: Semantics(
                      label: '${journeyLabel(l, s.stage)}, $tag',
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(journeyLabel(l, s.stage), key: Key('stage_${s.stage.name}'), style: VipType.headline),
                        Text(
                          s.state == StageState.current ? tag : l.journeyItems(s.readyCount, s.itemCount),
                          style: VipType.caption.copyWith(color: s.state == StageState.current ? p.lagoon : p.textSecondary),
                        ),
                      ]),
                    ),
                  ),
                ),
              ]),
            );
          },
        ),
      ),
    );
  }
}
