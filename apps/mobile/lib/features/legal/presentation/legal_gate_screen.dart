import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/network/api_error.dart';
import '../../../core/providers.dart';
import '../../../core/ui/error_text.dart';
import 'legal_controller.dart';

/// Screen 4 — Disclaimer Gate. Blocking: no back navigation, no skip. Re-shown when a version changes.
class LegalGateScreen extends ConsumerStatefulWidget {
  const LegalGateScreen({super.key});

  @override
  ConsumerState<LegalGateScreen> createState() => _LegalGateScreenState();
}

class _LegalGateScreenState extends ConsumerState<LegalGateScreen> {
  bool _checked = false;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final docs = ref.watch(pendingLegalProvider);
    final accept = ref.watch(legalAcceptControllerProvider);
    final changed = accept.error is ApiError && (accept.error! as ApiError).code == ApiCodes.validationFailed;

    return PopScope(
      canPop: false,
      child: Scaffold(
        appBar: AppBar(title: Text(l.legalTitle), automaticallyImplyLeading: false),
        body: SafeArea(
          child: docs.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(errorText(l, e), textAlign: TextAlign.center),
                const SizedBox(height: 12),
                FilledButton(onPressed: () => ref.invalidate(pendingLegalProvider), child: Text(l.commonRetry)),
              ]),
            ),
            data: (list) => Column(
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.all(16),
                    children: [
                      Text(l.legalIntro),
                      if (changed) Padding(padding: const EdgeInsets.only(top: 8), child: Text(l.legalChanged, key: const Key('legalChanged'))),
                      for (final d in list) ...[
                        const SizedBox(height: 16),
                        Text(d.title, style: Theme.of(context).textTheme.titleMedium),
                        const SizedBox(height: 8),
                        // Markdown body shown as plain text for now; rendering is a presentation concern only.
                        Text(d.bodyMd),
                      ],
                    ],
                  ),
                ),
                if (accept.hasError && !changed)
                  Padding(padding: const EdgeInsets.all(8), child: Text(errorText(l, accept.error!), key: const Key('legalError'))),
                CheckboxListTile(
                  key: const Key('legalCheck'),
                  value: _checked,
                  onChanged: (v) => setState(() => _checked = v ?? false),
                  title: Text(l.legalAccept),
                  controlAffinity: ListTileControlAffinity.leading,
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  child: SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      key: const Key('legalAccept'),
                      onPressed: (!_checked || accept.isLoading || list.isEmpty)
                          ? null
                          : () => ref.read(legalAcceptControllerProvider.notifier).accept(
                                list.map((d) => d.id).toList(),
                                appVersion: ref.read(appInfoProvider).appVersion,
                              ),
                      child: Text(l.legalAcceptButton),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
