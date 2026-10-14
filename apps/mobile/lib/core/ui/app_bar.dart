import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/glass_surface.dart';
import '../design/tokens.dart';
import '../l10n/app_localizations.dart';
import '../../features/notifications/presentation/notification_bell.dart';

/// The pinned glass bar (blur 20, the one place blur reads as glass). Content scrolls under it on `full`.
class GlassAppBar extends ConsumerWidget implements PreferredSizeWidget {
  const GlassAppBar({required this.title, this.actions = const [], this.showBell = true, this.leading, super.key});
  final String title;
  final List<Widget> actions;
  final bool showBell;
  final Widget? leading;

  @override
  Size get preferredSize => const Size.fromHeight(kToolbarHeight);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return GlassSurface(
      blur: Blur.bar,
      radius: 0,
      child: SafeArea(
        bottom: false,
        child: SizedBox(
          height: kToolbarHeight,
          child: Row(children: [
            leading ?? (Navigator.canPop(context) ? const BackButton() : const SizedBox(width: Sp.l)),
            Expanded(child: Semantics(header: true, child: Text(title, style: VipType.title, overflow: TextOverflow.ellipsis))),
            ...actions,
            if (showBell) const NotificationBell(),
            const SizedBox(width: Sp.xs),
          ]),
        ),
      ),
    );
  }
}

/// Tappable list-card surface: unblurred tint, never a BackdropFilter inside a list.
class TintCard extends StatelessWidget {
  const TintCard({required this.child, this.onTap, this.padding = const EdgeInsets.all(Sp.l), this.semanticLabel, super.key});
  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsetsGeometry padding;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final card = Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(Rad.lg),
        onTap: onTap,
        child: Padding(padding: padding, child: child),
      ),
    );
    return semanticLabel == null ? card : Semantics(label: semanticLabel, button: onTap != null, child: card);
  }
}

String categoryLabel(AppLocalizations l, String category) => switch (category) {
      'spouse' => l.categorySpouse,
      'child' => l.categoryChild,
      'parent' => l.categoryParent,
      _ => category,
    };
