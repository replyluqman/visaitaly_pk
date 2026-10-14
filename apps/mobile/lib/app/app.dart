import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/l10n/app_localizations.dart';
import '../core/providers.dart';
import '../core/design/mesh_background.dart';
import '../core/design/perf_tier.dart';
import '../core/design/theme.dart';
import '../core/design/tokens.dart';
import '../features/notifications/presentation/notifications_controller.dart';
import 'router.dart';

class VisaItalyApp extends ConsumerStatefulWidget {
  const VisaItalyApp({super.key});

  @override
  ConsumerState<VisaItalyApp> createState() => _VisaItalyAppState();
}

class _VisaItalyAppState extends ConsumerState<VisaItalyApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // The tier is decided from the device when its provider first builds; the frame monitor can only lower it.
    _frames = FrameDropMonitor(onDowngrade: () => ref.read(perfTierProvider.notifier).downgradeToLite());
    SchedulerBinding.instance.addTimingsCallback(_frames.onTimings);
  }

  late final FrameDropMonitor _frames;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    SchedulerBinding.instance.removeTimingsCallback(_frames.onTimings);
    super.dispose();
  }

  /// Resume after a long pause: re-fetch /v1/me so entitlement and legal state are never stale (PRD §5).
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(sessionControllerProvider.notifier).refreshIfStale();
      ref.invalidate(unreadCountProvider); // the bell badge is cheap to refresh and goes stale while backgrounded
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      onGenerateTitle: (c) => AppLocalizations.of(c).appName,
      routerConfig: ref.watch(routerProvider),
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      builder: (context, child) => MediaQuery.withClampedTextScaling(
        maxScaleFactor: VipType.maxScale, // OS font scale is honoured up to 1.3×
        child: MeshBackground(child: child ?? const SizedBox.shrink()),
      ),
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: AppLocalizations.supportedLocales,
    );
  }
}
