import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/ui/error_text.dart';
import 'applicant_count_controller.dart';

/// Screen 5 — Applicant Count: 1 / 2 / 3 / 4+ (4+ opens a stepper, server accepts 1–99).
class ApplicantCountScreen extends ConsumerStatefulWidget {
  const ApplicantCountScreen({super.key});

  @override
  ConsumerState<ApplicantCountScreen> createState() => _ApplicantCountScreenState();
}

class _ApplicantCountScreenState extends ConsumerState<ApplicantCountScreen> {
  int? _count;
  bool _fourPlus = false;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final state = ref.watch(applicantCountControllerProvider);

    Widget option(int n) => ChoiceChip(
          key: Key('count$n'),
          label: Text('$n'),
          selected: !_fourPlus && _count == n,
          onSelected: (_) => setState(() {
            _fourPlus = false;
            _count = n;
          }),
        );

    return PopScope(
      canPop: false,
      child: Scaffold(
        appBar: AppBar(title: Text(l.countTitle), automaticallyImplyLeading: false),
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text(l.countQuestion, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 16),
              Wrap(spacing: 8, children: [
                option(1),
                option(2),
                option(3),
                ChoiceChip(
                  key: const Key('countFourPlus'),
                  label: Text(l.countFourPlus),
                  selected: _fourPlus,
                  onSelected: (_) => setState(() {
                    _fourPlus = true;
                    _count = (_count ?? 0) < 4 ? 4 : _count;
                  }),
                ),
              ]),
              if (_fourPlus) ...[
                const SizedBox(height: 16),
                Row(children: [
                  Text(l.countHowMany),
                  const Spacer(),
                  IconButton(
                    key: const Key('countMinus'),
                    onPressed: (_count ?? 4) > 4 ? () => setState(() => _count = _count! - 1) : null,
                    icon: const Icon(Icons.remove_circle_outline),
                  ),
                  Text('$_count', key: const Key('countValue')),
                  IconButton(
                    key: const Key('countPlus'),
                    onPressed: (_count ?? 4) < 99 ? () => setState(() => _count = (_count ?? 4) + 1) : null,
                    icon: const Icon(Icons.add_circle_outline),
                  ),
                ]),
              ],
              if (state.hasError) Padding(padding: const EdgeInsets.only(top: 16), child: Text(errorText(l, state.error!))),
              const SizedBox(height: 24),
              FilledButton(
                key: const Key('countContinue'),
                onPressed: (_count == null || state.isLoading) ? null : () => ref.read(applicantCountControllerProvider.notifier).submit(_count!),
                child: Text(l.commonContinue),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
