import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/design/glass_surface.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/network/api_error.dart';
import '../../../core/providers.dart';
import '../../../core/settings_store.dart';
import '../../../core/ui/error_text.dart';
import '../data/dto/public_dto.dart';

final eligibilityQuestionsProvider = FutureProvider.autoDispose<EligibilityQuestionSet>(
  (ref) => ref.watch(publicRepositoryProvider).eligibilityQuestions(),
);

/// Screen 2 — Eligibility Quick Check. Pre-auth, stateless, no account. The result is ORIENTATION, never a verdict:
/// every word of it (summary, items, disclaimer) comes from the CMS and went through legal review; this screen adds
/// only neutral labels.
class EligibilityScreen extends ConsumerStatefulWidget {
  const EligibilityScreen({super.key});

  @override
  ConsumerState<EligibilityScreen> createState() => _EligibilityScreenState();
}

class _EligibilityScreenState extends ConsumerState<EligibilityScreen> {
  final Map<String, String> _answers = {};
  int _step = -1; // -1 = intro
  EligibilityResult? _result;
  bool _submitting = false;
  bool _stale = false;
  Object? _error;

  Future<void> _leave({bool signup = false}) async {
    await ref.read(firstOpenProvider.notifier).markSeen();
    if (mounted) context.go(Routes.login);
  }

  Future<void> _submit(EligibilityQuestionSet set) async {
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final r = await ref.read(publicRepositoryProvider).submitEligibility(version: set.version, answers: _answers);
      if (mounted) setState(() => _result = r);
    } on ApiError catch (e) {
      if (e.code == ApiCodes.validationFailed && e.details.containsKey('version')) {
        // The question set changed under us: reload it and start over.
        ref.invalidate(eligibilityQuestionsProvider);
        if (mounted) {
          setState(() {
            _answers.clear();
            _step = -1;
            _stale = true;
          });
        }
      } else if (mounted) {
        setState(() => _error = e);
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final questions = ref.watch(eligibilityQuestionsProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l.eligTitle), actions: [
        TextButton(key: const Key('eligSkip'), onPressed: _leave, child: Text(l.eligSkip)),
      ]),
      body: SafeArea(
        child: questions.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => Center(
            child: Padding(
              padding: const EdgeInsets.all(Sp.xxl),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(e is ApiError && e.code == ApiCodes.notFound ? l.eligUnavailable : errorText(l, e), textAlign: TextAlign.center),
                const SizedBox(height: Sp.m),
                FilledButton(onPressed: () => ref.invalidate(eligibilityQuestionsProvider), child: Text(l.commonRetry)),
                TextButton(onPressed: _leave, child: Text(l.eligSkip)),
              ]),
            ),
          ),
          data: (set) {
            if (_result != null) return _ResultView(result: _result!, onCreate: _leave);

            if (_step < 0) {
              return ListView(padding: const EdgeInsets.all(Sp.xxl), children: [
                if (_stale) Padding(padding: const EdgeInsets.only(bottom: Sp.m), child: Text(l.eligStale, key: const Key('eligStale'))),
                Text(l.eligIntro, style: VipType.body),
                const SizedBox(height: Sp.xl),
                FilledButton(key: const Key('eligStart'), onPressed: set.questions.isEmpty ? null : () => setState(() => _step = 0), child: Text(l.eligStart)),
                const SizedBox(height: Sp.xl),
                Text(set.disclaimer, key: const Key('eligDisclaimerIntro'), style: VipType.caption.copyWith(color: p.textSecondary)),
              ]);
            }

            final q = set.questions[_step];
            final last = _step == set.questions.length - 1;
            final chosen = _answers[q.id];
            return ListView(padding: const EdgeInsets.all(Sp.xxl), children: [
              Text(l.eligProgress(_step + 1, set.questions.length), style: VipType.caption.copyWith(color: p.textSecondary)),
              const SizedBox(height: Sp.s),
              Text(q.text, key: const Key('eligQuestion'), style: VipType.title),
              const SizedBox(height: Sp.l),
              RadioGroup<String>(
                groupValue: chosen,
                onChanged: (v) => setState(() => _answers[q.id] = v!),
                child: Column(children: [
                  for (final o in q.options) RadioListTile<String>(key: Key('opt_${o.value}'), title: Text(o.label), value: o.value),
                ]),
              ),
              if (_error != null) Padding(padding: const EdgeInsets.only(top: Sp.m), child: Text(errorText(l, _error!))),
              const SizedBox(height: Sp.l),
              Row(children: [
                if (_step > 0) OutlinedButton(key: const Key('eligBack'), onPressed: () => setState(() => _step--), child: Text(l.eligBack)),
                const Spacer(),
                FilledButton(
                  key: const Key('eligNext'),
                  onPressed: chosen == null || _submitting ? null : (last ? () => _submit(set) : () => setState(() => _step++)),
                  child: Text(last ? l.eligSeeResult : l.eligNext),
                ),
              ]),
              const SizedBox(height: Sp.xl),
              Text(set.disclaimer, style: VipType.caption.copyWith(color: p.textSecondary)),
            ]);
          },
        ),
      ),
    );
  }
}

class _ResultView extends ConsumerWidget {
  const _ResultView({required this.result, required this.onCreate});
  final EligibilityResult result;
  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    return ListView(padding: const EdgeInsets.all(Sp.xxl), children: [
      Text(l.eligResultTitle, style: VipType.title),
      const SizedBox(height: Sp.m),
      Text(result.summary, key: const Key('eligSummary'), style: VipType.body),
      const SizedBox(height: Sp.l),
      for (final i in result.typicalItems)
        Padding(
          padding: const EdgeInsets.only(bottom: Sp.s),
          child: Card(
            child: ListTile(
              key: Key('typical_${i.title}'),
              leading: Icon(Icons.description_outlined, color: p.lagoon),
              title: Text(i.title),
              subtitle: i.why == null ? null : Text(i.why!),
            ),
          ),
        ),
      if (result.lockedCount > 0)
        Padding(padding: const EdgeInsets.only(top: Sp.s), child: Text(l.eligLocked(result.lockedCount), key: const Key('eligLocked'), style: VipType.label.copyWith(color: p.terracotta))),
      const SizedBox(height: Sp.xl),
      FilledButton(key: const Key('eligCreate'), onPressed: onCreate, child: Text(l.eligCreate)),
      if (result.whatsappUrl != null) ...[
        const SizedBox(height: Sp.s),
        OutlinedButton(key: const Key('eligWhatsapp'), onPressed: () => ref.read(urlOpenerProvider)(Uri.parse(result.whatsappUrl!)), child: Text(l.eligWhatsapp, textAlign: TextAlign.center)),
      ],
      const SizedBox(height: Sp.xl),
      GlassSurface(
        strong: true,
        padding: const EdgeInsets.all(Sp.m),
        child: Text(result.disclaimer, key: const Key('eligDisclaimer'), style: VipType.caption),
      ),
    ]);
  }
}
