import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/providers.dart';
import '../../../core/session/session_state.dart';
import '../../../core/ui/error_text.dart';

/// Screen 1 — resolves the Firebase session and the /v1/me snapshot, then the router moves on.
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final state = ref.watch(sessionControllerProvider);
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: switch (state) {
            SessionFailed(:final error) => Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(l.splashFailed, style: Theme.of(context).textTheme.titleMedium, textAlign: TextAlign.center),
                  const SizedBox(height: 8),
                  Text(errorText(l, error), textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: () => ref.read(sessionControllerProvider.notifier).retry(),
                    child: Text(l.commonRetry),
                  ),
                ],
              ),
            _ => Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(l.appName, style: Theme.of(context).textTheme.headlineMedium),
                  const SizedBox(height: 4),
                  Text(l.splashTagline),
                  const SizedBox(height: 24),
                  const CircularProgressIndicator(),
                ],
              ),
          },
        ),
      ),
    );
  }
}
