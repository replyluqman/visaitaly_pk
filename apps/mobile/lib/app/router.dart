import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/models/enums.dart';
import '../core/providers.dart';
import '../core/session/session_state.dart';
import '../features/applicants/presentation/applicant_form_screen.dart';
import '../features/applicants/presentation/stage_select_screen.dart';
import '../features/auth/presentation/login_screen.dart';
import '../features/auth/presentation/splash_screen.dart';
import '../features/auth/presentation/update_required_screen.dart';
import '../features/home/presentation/home_screen.dart';
import '../features/legal/presentation/legal_gate_screen.dart';
import '../features/onboarding/presentation/applicant_count_screen.dart';

abstract final class Routes {
  static const splash = '/splash';
  static const update = '/update';
  static const login = '/login';
  static const legal = '/legal';
  static const count = '/onboarding/count';
  static const applicant = '/onboarding/applicant';
  static const stage = '/onboarding/stage';
  static const home = '/home';
  static const addApplicant = '/home/applicants/new';
}

const _onboardingPaths = {Routes.legal, Routes.count, Routes.applicant, Routes.stage};

/// The whole routing policy, as a pure function of server state (docs/FLUTTER-ARCHITECTURE.md, order matters):
/// no Firebase user → Login · no snapshot yet → Splash · legal pending → Disclaimer Gate ·
/// then `onboardingState`. Local flags never decide. Returns null to stay where we are.
String? computeRedirect(SessionState s, String location) {
  switch (s) {
    case SessionLoading() || SessionFailed():
      return location == Routes.splash ? null : Routes.splash;
    case SessionSignedOut():
      return location == Routes.login ? null : Routes.login;
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
          // Auth/onboarding screens are dead ends for a finished user; everything under /home is fine.
          if (location == Routes.splash || location == Routes.login || _onboardingPaths.contains(location)) {
            return Routes.home;
          }
          return null;
      }
  }
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = ValueNotifier<int>(0);
  ref.listen(sessionControllerProvider, (_, _) => refresh.value++);
  ref.onDispose(refresh.dispose);

  final router = GoRouter(
    initialLocation: Routes.splash,
    refreshListenable: refresh,
    redirect: (context, state) => computeRedirect(ref.read(sessionControllerProvider), state.matchedLocation),
    routes: [
      GoRoute(path: Routes.splash, builder: (_, _) => const SplashScreen()),
      GoRoute(path: Routes.update, builder: (_, _) => const UpdateRequiredScreen()),
      GoRoute(path: Routes.login, builder: (_, _) => const LoginScreen()),
      GoRoute(path: Routes.legal, builder: (_, _) => const LegalGateScreen()),
      GoRoute(path: Routes.count, builder: (_, _) => const ApplicantCountScreen()),
      GoRoute(path: Routes.applicant, builder: (_, _) => const ApplicantFormScreen(onboarding: true)),
      GoRoute(path: Routes.stage, builder: (_, _) => const StageSelectScreen()),
      GoRoute(
        path: Routes.home,
        builder: (_, _) => const HomeScreen(),
        routes: [GoRoute(path: 'applicants/new', builder: (_, _) => const ApplicantFormScreen(onboarding: false))],
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
