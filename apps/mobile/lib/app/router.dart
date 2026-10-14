import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/models/enums.dart';
import '../core/providers.dart';
import '../core/session/session_state.dart';
import '../core/settings_store.dart';
import '../features/account/presentation/account_screen.dart';
import '../features/applicants/presentation/applicant_form_screen.dart';
import '../features/applicants/presentation/stage_select_screen.dart';
import '../features/auth/presentation/login_screen.dart';
import '../features/auth/presentation/splash_screen.dart';
import '../features/auth/presentation/update_required_screen.dart';
import '../features/checklist/presentation/case_view_screen.dart';
import '../features/checklist/presentation/item_detail_screen.dart';
import '../features/checklist/presentation/journey_screen.dart';
import '../features/documents/presentation/documents_screen.dart';
import '../features/home/presentation/home_screen.dart';
import '../features/home/presentation/main_shell.dart';
import '../features/legal/presentation/legal_gate_screen.dart';
import '../features/notifications/presentation/notifications_screen.dart';
import '../features/onboarding/presentation/applicant_count_screen.dart';
import '../features/public/presentation/eligibility_screen.dart';
import '../features/public/presentation/verify_screen.dart';
import '../features/support/presentation/support_screen.dart';
import '../features/today/presentation/today_screen.dart';
import 'routes.dart';

export 'routes.dart';

const _onboardingPaths = {Routes.legal, Routes.count, Routes.applicant, Routes.stage};

/// The whole routing policy, as a pure function of server state (docs/FLUTTER-ARCHITECTURE.md, order matters):
/// no Firebase user → Quick Check on the very first open, otherwise Login · no snapshot yet → Splash ·
/// outdated build → Update · legal pending → Disclaimer Gate · then `onboardingState`.
/// Local flags never decide anything about the account; [firstOpen] only picks which signed-out screen comes first.
/// Returns null to stay where we are.
String? computeRedirect(SessionState s, String location, {bool firstOpen = false}) {
  switch (s) {
    case SessionLoading() || SessionFailed():
      return location == Routes.splash ? null : Routes.splash;
    case SessionSignedOut():
      if (location == Routes.login || location == Routes.eligibility || location == Routes.verify) return null;
      if (location == Routes.splash && firstOpen) return Routes.eligibility;
      return Routes.login;
    case SessionUpdateRequired():
      return location == Routes.update ? null : Routes.update;
    case SessionReady(:final me):
      String? to(String target) => location == target ? null : target;
      if (me.legal.requiresAcceptance) return to(Routes.legal);
      switch (me.user.onboardingState) {
        case OnboardingState.disclaimerPending:
          return to(Routes.legal);
        case OnboardingState.applicantsPending:
          if (me.applicants.declaredCount == null) return to(Routes.count);
          // Count answered: add applicants until the server says we have enough.
          return to(Routes.applicant);
        case OnboardingState.stagePending:
          return to(Routes.stage);
        case OnboardingState.complete || OnboardingState.unknown:
          // Auth/onboarding screens are dead ends for a finished user; everything else is fine.
          if (location == Routes.splash || location == Routes.login || location == Routes.eligibility || _onboardingPaths.contains(location)) {
            return Routes.home;
          }
          return null;
      }
  }
}

final _rootKey = GlobalKey<NavigatorState>(debugLabel: 'root');

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(sessionControllerProvider, (_, _) => refresh.value++);
  ref.listen(firstOpenProvider, (_, _) => refresh.value++);
  ref.onDispose(refresh.dispose);

  GoRoute pushed(String path, Widget Function(GoRouterState) b) =>
      GoRoute(path: path, parentNavigatorKey: _rootKey, builder: (_, s) => b(s));

  final router = GoRouter(
    navigatorKey: _rootKey,
    initialLocation: Routes.splash,
    refreshListenable: refresh,
    redirect: (context, state) =>
        computeRedirect(ref.read(sessionControllerProvider), state.matchedLocation, firstOpen: ref.read(firstOpenProvider)),
    routes: [
      GoRoute(path: Routes.splash, builder: (_, _) => const SplashScreen()),
      GoRoute(path: Routes.update, builder: (_, _) => const UpdateRequiredScreen()),
      GoRoute(path: Routes.login, builder: (_, _) => const LoginScreen()),
      GoRoute(path: Routes.eligibility, builder: (_, _) => const EligibilityScreen()),
      GoRoute(path: Routes.legal, builder: (_, _) => const LegalGateScreen()),
      GoRoute(path: Routes.count, builder: (_, _) => const ApplicantCountScreen()),
      GoRoute(path: Routes.applicant, builder: (_, _) => const ApplicantFormScreen(onboarding: true)),
      GoRoute(path: Routes.stage, builder: (_, _) => const StageSelectScreen()),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => MainShell(navigationShell: shell),
        branches: [
          StatefulShellBranch(routes: [GoRoute(path: Routes.home, builder: (_, _) => const HomeScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.today, builder: (_, _) => const TodayScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.documents, builder: (_, _) => const DocumentsScreen())]),
          StatefulShellBranch(routes: [GoRoute(path: Routes.account, builder: (_, _) => const AccountScreen())]),
        ],
      ),
      // Pushed over the shell. `/applicants/new` must precede `/applicants/:id`.
      pushed(Routes.addApplicant, (_) => const ApplicantFormScreen(onboarding: false)),
      pushed('/applicants/:id', (s) => CaseViewScreen(applicantId: s.pathParameters['id']!)),
      pushed('/applicants/:id/journey', (s) => JourneyScreen(applicantId: s.pathParameters['id']!)),
      pushed('/checklist/:id', (s) => ItemDetailScreen(itemId: s.pathParameters['id']!)),
      pushed(Routes.notifications, (_) => const NotificationsScreen()),
      pushed(Routes.support, (_) => const SupportScreen()),
      pushed(Routes.verify, (_) => const VerifyScreen()),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
