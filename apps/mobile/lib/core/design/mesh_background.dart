import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'perf_tier.dart';
import 'tokens.dart';

/// The backdrop glass sits on: three soft colour blobs (lagoon / indigo / terracotta) over the base colour.
/// Painted once and isolated in a RepaintBoundary, so it costs one raster per size change rather than a live
/// shader. `solid` tier: plain base colour, no mesh.
class MeshBackground extends ConsumerWidget {
  const MeshBackground({required this.child, super.key});
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = context.vip;
    final tier = ref.watch(perfTierProvider);
    return ColoredBox(
      color: p.bgBase,
      child: Stack(fit: StackFit.expand, children: [
        if (tier != PerfTier.solid) RepaintBoundary(child: CustomPaint(painter: _MeshPainter(p))),
        child,
      ]),
    );
  }
}

class _MeshPainter extends CustomPainter {
  _MeshPainter(this.p);
  final VipPalette p;

  @override
  void paint(Canvas canvas, Size size) {
    void blob(Offset c, double r, Color color) {
      final paint = Paint()
        ..shader = RadialGradient(colors: [color.withValues(alpha: p.meshOpacity), color.withValues(alpha: 0)])
            .createShader(Rect.fromCircle(center: c, radius: r));
      canvas.drawCircle(c, r, paint);
    }

    blob(Offset(size.width * 0.15, size.height * 0.10), size.width * 0.75, p.meshLagoon);
    blob(Offset(size.width * 0.95, size.height * 0.35), size.width * 0.70, p.meshIndigo);
    blob(Offset(size.width * 0.30, size.height * 0.95), size.width * 0.80, p.meshTerracotta);
  }

  @override
  bool shouldRepaint(_MeshPainter old) => old.p != p;
}
