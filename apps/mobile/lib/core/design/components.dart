import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../l10n/app_localizations.dart';
import '../models/enums.dart';
import 'tokens.dart';

/// Colour + icon + label, always together (WCAG 1.4.1) — never colour alone.
class StatusStyle {
  const StatusStyle(this.color, this.icon, this.label);
  final Color color;
  final IconData icon;
  final String label;
}

StatusStyle statusStyle(BuildContext context, ItemStatus s) {
  final p = context.vip;
  final l = AppLocalizations.of(context);
  return switch (s) {
    ItemStatus.notStarted || ItemStatus.unknown => StatusStyle(p.statusNotStarted, Icons.radio_button_unchecked, l.statusNotStarted),
    ItemStatus.inProgress => StatusStyle(p.statusInProgress, Icons.timelapse, l.statusInProgress),
    ItemStatus.ready => StatusStyle(p.statusReady, Icons.check_circle, l.statusReady),
    ItemStatus.issueFound => StatusStyle(p.statusIssueFound, Icons.warning_amber_rounded, l.statusIssueFound),
    ItemStatus.notApplicable => StatusStyle(p.statusNotApplicable, Icons.remove_circle_outline, l.statusNotApplicable),
  };
}

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key});
  final ItemStatus status;

  @override
  Widget build(BuildContext context) {
    final s = statusStyle(context, status);
    return AnimatedContainer(
      duration: Motion.statusChange,
      curve: Motion.curve,
      padding: const EdgeInsets.symmetric(horizontal: Sp.m, vertical: Sp.xs + 2),
      decoration: BoxDecoration(color: s.color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(Rad.pill)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(s.icon, size: 16, color: s.color),
        const SizedBox(width: Sp.xs + 2),
        Text(s.label, style: VipType.label.copyWith(color: s.color)),
      ]),
    );
  }
}

/// Badges are orthogonal to status and may stack.
class BadgePill extends StatelessWidget {
  const BadgePill(this.badge, {super.key});
  final ItemBadge badge;

  @override
  Widget build(BuildContext context) {
    final p = context.vip;
    final l = AppLocalizations.of(context);
    final (Color c, IconData icon, String label, bool outline) = switch (badge) {
      ItemBadge.blocking || ItemBadge.unknown => (p.badgeBlocking, Icons.lock_outline, l.badgeBlocking, true),
      ItemBadge.needsReview => (p.badgeNeedsReview, Icons.sync_problem, l.badgeNeedsReview, false),
      ItemBadge.sourceUnderReview => (p.badgeSourceUnderReview, Icons.visibility_outlined, l.badgeSourceUnderReview, false),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: Sp.s + 2, vertical: Sp.xs),
      decoration: BoxDecoration(
        color: outline ? Colors.transparent : c.withValues(alpha: 0.16),
        border: outline ? Border.all(color: c) : null,
        borderRadius: BorderRadius.circular(Rad.pill),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 14, color: c),
        const SizedBox(width: Sp.xs),
        Flexible(child: Text(label, style: VipType.caption.copyWith(color: c), overflow: TextOverflow.ellipsis)),
      ]),
    );
  }
}

/// "Verified 12 days ago" — prominent, top of item detail, never a footer (PRD §13). Amber beyond [staleAfterDays].
class VerifiedStamp extends StatelessWidget {
  const VerifiedStamp({required this.lastVerifiedAt, required this.staleAfterDays, required this.now, super.key});
  final DateTime? lastVerifiedAt;
  final int staleAfterDays;
  final DateTime now;

  static int daysSince(DateTime at, DateTime now) => now.difference(at).inDays.clamp(0, 100000);

  @override
  Widget build(BuildContext context) {
    final p = context.vip;
    final l = AppLocalizations.of(context);
    final at = lastVerifiedAt;
    final days = at == null ? null : daysSince(at, now);
    final stale = days == null || days > staleAfterDays;
    final color = stale ? p.badgeNeedsReview : p.statusReady;
    return Container(
      key: const Key('verifiedStamp'),
      padding: const EdgeInsets.symmetric(horizontal: Sp.m, vertical: Sp.s),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(Rad.md)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(stale ? Icons.schedule : Icons.verified_outlined, size: 18, color: color),
        const SizedBox(width: Sp.s),
        Text(days == null ? l.verifiedNever : l.verifiedDaysAgo(days), style: VipType.label.copyWith(color: color)),
      ]),
    );
  }
}

/// Readiness as a bar that tweens (never snaps). Semantics read the percentage and blockers aloud.
class ReadinessBar extends StatelessWidget {
  const ReadinessBar({required this.percent, required this.blocking, this.height = 8, super.key});
  final num percent;
  final int blocking;
  final double height;

  @override
  Widget build(BuildContext context) {
    final p = context.vip;
    final l = AppLocalizations.of(context);
    final pct = percent.round().clamp(0, 100);
    return Semantics(
      label: l.readinessSemantics(pct, blocking),
      excludeSemantics: true,
      child: TweenAnimationBuilder<double>(
        tween: Tween(end: pct / 100),
        duration: Motion.readinessTween,
        curve: Motion.curve,
        builder: (_, v, _) => ClipRRect(
          borderRadius: BorderRadius.circular(Rad.pill),
          child: LinearProgressIndicator(
            value: v,
            minHeight: height,
            backgroundColor: p.strokeHairline,
            valueColor: AlwaysStoppedAnimation(p.lagoon),
          ),
        ),
      ),
    );
  }
}

class ReadinessRing extends StatelessWidget {
  const ReadinessRing({required this.percent, required this.blocking, this.size = 72, super.key});
  final num percent;
  final int blocking;
  final double size;

  @override
  Widget build(BuildContext context) {
    final p = context.vip;
    final l = AppLocalizations.of(context);
    final pct = percent.round().clamp(0, 100);
    return Semantics(
      label: l.readinessSemantics(pct, blocking),
      excludeSemantics: true,
      child: SizedBox(
        width: size,
        height: size,
        child: TweenAnimationBuilder<double>(
          tween: Tween(end: pct / 100),
          duration: Motion.readinessTween,
          curve: Motion.curve,
          builder: (_, v, _) => Stack(alignment: Alignment.center, children: [
            SizedBox.expand(
              child: CircularProgressIndicator(value: v, strokeWidth: 7, backgroundColor: p.strokeHairline, valueColor: AlwaysStoppedAnimation(p.lagoon)),
            ),
            Text('$pct%', style: VipType.headline),
          ]),
        ),
      ),
    );
  }
}

/// Verbatim copy from Screens v2 "Empty States" is passed in by the caller.
class EmptyState extends StatelessWidget {
  const EmptyState({required this.message, this.icon = Icons.inbox_outlined, this.action, super.key});
  final String message;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final p = context.vip;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Sp.xxl),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 48, color: p.textSecondary),
          const SizedBox(height: Sp.l),
          Text(message, textAlign: TextAlign.center, style: VipType.body.copyWith(color: p.textSecondary)),
          if (action != null) ...[const SizedBox(height: Sp.l), action!],
        ]),
      ),
    );
  }
}

/// Tactile feedback, centralised so tests and the reduce-motion setting have one switch.
abstract final class Haptics {
  static void light() => HapticFeedback.lightImpact();
  static void medium() => HapticFeedback.mediumImpact();
}
