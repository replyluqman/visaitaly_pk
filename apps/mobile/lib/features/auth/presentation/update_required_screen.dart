import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/providers.dart';

/// Shown when this build is older than the server's minimum (ADR 0013). Blocking, but the user is NOT signed out:
/// updating puts them straight back where they were.
class UpdateRequiredScreen extends ConsumerStatefulWidget {
  const UpdateRequiredScreen({super.key});

  @override
  ConsumerState<UpdateRequiredScreen> createState() => _UpdateRequiredScreenState();
}

class _UpdateRequiredScreenState extends ConsumerState<UpdateRequiredScreen> {
  bool _failed = false;

  Future<void> _open() async {
    final id = ref.read(appInfoProvider).packageName;
    final ok = await ref.read(urlOpenerProvider)(Uri.parse('market://details?id=$id'));
    if (!ok && mounted) setState(() => _failed = true);
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return PopScope(
      canPop: false,
      child: Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(l.updateTitle, style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 12),
              Text(l.updateBody, textAlign: TextAlign.center),
              if (_failed) Padding(padding: const EdgeInsets.only(top: 12), child: Text(l.updateFailed, key: const Key('updateFailed'))),
              const SizedBox(height: 24),
              FilledButton(key: const Key('updateButton'), onPressed: _open, child: Text(l.updateButton)),
            ]),
          ),
        ),
      ),
    );
  }
}
