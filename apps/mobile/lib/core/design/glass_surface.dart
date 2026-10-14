import 'dart:ui';

import 'package:flutter/material.dart';

import 'perf_tier.dart';
import 'tokens.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The ONLY place a BackdropFilter may be created (DESIGN-SYSTEM.md §3-4; enforced by test/design/no_backdrop_test.dart).
/// full  → blurred glass · lite → unblurred tint · solid → opaque surface.
/// Never put one inside a list item and never stack glass on glass.
class GlassSurface extends ConsumerWidget {
  const GlassSurface({
    required this.child,
    this.blur = Blur.bar,
    this.radius = Rad.lg,
    this.strong = false,
    this.padding,
    this.borderRadius,
    super.key,
  });

  final Widget child;
  final double blur;
  final double radius;

  /// Use the solid surface even on `full` (text-heavy content: legal, item body, support thread).
  final bool strong;
  final EdgeInsetsGeometry? padding;
  final BorderRadius? borderRadius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tier = ref.watch(perfTierProvider);
    final p = context.vip;
    final br = borderRadius ?? BorderRadius.circular(radius);
    final Color fill = switch (tier) {
      _ when strong => p.surfaceSolid,
      PerfTier.full => p.surfaceGlass,
      PerfTier.lite => p.surfaceTint,
      PerfTier.solid => p.surfaceSolid,
    };
    final decorated = DecoratedBox(
      decoration: BoxDecoration(
        color: fill,
        borderRadius: br,
        border: Border.all(color: tier == PerfTier.solid ? p.strokeHairline : p.strokeGlass),
      ),
      child: Padding(padding: padding ?? EdgeInsets.zero, child: child),
    );
    if (tier != PerfTier.full || strong) return ClipRRect(borderRadius: br, child: decorated);
    return ClipRRect(
      borderRadius: br,
      child: BackdropFilter(filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur), child: decorated),
    );
  }
}
