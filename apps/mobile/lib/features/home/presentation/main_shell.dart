import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/glass_surface.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';

/// The bottom navigation (glass, blur 20): Home · Today · Documents · Account. Everything else is pushed on top
/// and covers it, so at most two live blurs (bar + nav) are ever on screen.
class MainShell extends StatelessWidget {
  const MainShell({required this.navigationShell, super.key});
  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: GlassSurface(
        blur: Blur.bar,
        radius: 0,
        child: NavigationBar(
          key: const Key('bottomNav'),
          selectedIndex: navigationShell.currentIndex,
          onDestinationSelected: (i) => navigationShell.goBranch(i, initialLocation: i == navigationShell.currentIndex),
          destinations: [
            NavigationDestination(icon: const Icon(Icons.home_outlined), selectedIcon: const Icon(Icons.home), label: l.navHome),
            NavigationDestination(icon: const Icon(Icons.today_outlined), selectedIcon: const Icon(Icons.today), label: l.navToday),
            NavigationDestination(icon: const Icon(Icons.folder_outlined), selectedIcon: const Icon(Icons.folder), label: l.navDocuments),
            NavigationDestination(icon: const Icon(Icons.person_outline), selectedIcon: const Icon(Icons.person), label: l.navAccount),
          ],
        ),
      ),
    );
  }
}
