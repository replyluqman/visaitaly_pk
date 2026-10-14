import 'package:flutter/material.dart';

/// Glass-lite tokens (docs/design/tokens.json is the source). Colours for both themes; the rest are constants.
@immutable
class VipPalette extends ThemeExtension<VipPalette> {
  const VipPalette({
    required this.bgBase,
    required this.meshLagoon,
    required this.meshIndigo,
    required this.meshTerracotta,
    required this.meshOpacity,
    required this.surfaceGlass,
    required this.surfaceTint,
    required this.surfaceSolid,
    required this.strokeGlass,
    required this.strokeHairline,
    required this.textPrimary,
    required this.textSecondary,
    required this.textOnBrand,
    required this.lagoon,
    required this.terracotta,
    required this.indigo,
    required this.statusNotStarted,
    required this.statusInProgress,
    required this.statusReady,
    required this.statusIssueFound,
    required this.statusNotApplicable,
    required this.badgeBlocking,
    required this.badgeNeedsReview,
    required this.badgeSourceUnderReview,
  });

  final Color bgBase, meshLagoon, meshIndigo, meshTerracotta;
  final double meshOpacity;
  final Color surfaceGlass, surfaceTint, surfaceSolid, strokeGlass, strokeHairline;
  final Color textPrimary, textSecondary, textOnBrand;
  final Color lagoon, terracotta, indigo;
  final Color statusNotStarted, statusInProgress, statusReady, statusIssueFound, statusNotApplicable;
  final Color badgeBlocking, badgeNeedsReview, badgeSourceUnderReview;

  static const light = VipPalette(
    bgBase: Color(0xFFEEF2F7),
    meshLagoon: Color(0xFF5FD3D9),
    meshIndigo: Color(0xFF7C8CFF),
    meshTerracotta: Color(0xFFF2A27F),
    meshOpacity: 0.35,
    surfaceGlass: Color.fromRGBO(255, 255, 255, 0.62),
    surfaceTint: Color.fromRGBO(255, 255, 255, 0.82),
    surfaceSolid: Color(0xFFFFFFFF),
    strokeGlass: Color.fromRGBO(255, 255, 255, 0.70),
    strokeHairline: Color.fromRGBO(11, 21, 48, 0.08),
    textPrimary: Color(0xFF0B1530),
    textSecondary: Color(0xFF475069),
    textOnBrand: Color(0xFFFFFFFF),
    lagoon: Color(0xFF0E7C86),
    terracotta: Color(0xFFC8552D),
    indigo: Color(0xFF2B3A8C),
    statusNotStarted: Color(0xFF6B7489),
    statusInProgress: Color(0xFF2563EB),
    statusReady: Color(0xFF15803D),
    statusIssueFound: Color(0xFFB42318),
    statusNotApplicable: Color(0xFF9AA1B2),
    badgeBlocking: Color(0xFFB42318),
    badgeNeedsReview: Color(0xFFB45309),
    badgeSourceUnderReview: Color(0xFF6D28D9),
  );

  static const dark = VipPalette(
    bgBase: Color(0xFF070D1F),
    meshLagoon: Color(0xFF0E7C86),
    meshIndigo: Color(0xFF2B3A8C),
    meshTerracotta: Color(0xFF8A3A1E),
    meshOpacity: 0.45,
    surfaceGlass: Color.fromRGBO(18, 26, 52, 0.58),
    surfaceTint: Color.fromRGBO(20, 29, 58, 0.86),
    surfaceSolid: Color(0xFF111A33),
    strokeGlass: Color.fromRGBO(255, 255, 255, 0.10),
    strokeHairline: Color.fromRGBO(255, 255, 255, 0.06),
    textPrimary: Color(0xFFF2F5FB),
    textSecondary: Color(0xFFA9B3CC),
    textOnBrand: Color(0xFF04121A),
    lagoon: Color(0xFF3CC4CC),
    terracotta: Color(0xFFF08A5D),
    indigo: Color(0xFF8C9BFF),
    statusNotStarted: Color(0xFF8D96AD),
    statusInProgress: Color(0xFF6EA0FF),
    statusReady: Color(0xFF4ADE80),
    statusIssueFound: Color(0xFFFF7A70),
    statusNotApplicable: Color(0xFF5D6680),
    badgeBlocking: Color(0xFFFF7A70),
    badgeNeedsReview: Color(0xFFFBBF24),
    badgeSourceUnderReview: Color(0xFFC4B5FD),
  );

  @override
  VipPalette copyWith() => this;

  @override
  VipPalette lerp(ThemeExtension<VipPalette>? other, double t) => t < 0.5 ? this : (other as VipPalette? ?? this);
}

extension VipContext on BuildContext {
  VipPalette get vip => Theme.of(this).extension<VipPalette>()!;
}

/// 4-pt spacing scale and the gutter (tokens.json `space`, `gutter`).
abstract final class Sp {
  static const double xs = 4, s = 8, m = 12, l = 16, xl = 20, xxl = 24, x3 = 32, x4 = 40;
  static const double gutter = 16;
}

abstract final class Rad {
  static const double sm = 10, md = 16, lg = 22, xl = 28, pill = 999;
}

abstract final class Blur {
  static const double bar = 20, sheet = 24, hero = 16, paywall = 24;
  static const int maxConcurrent = 2;
}

abstract final class Motion {
  static const sharedAxis = Duration(milliseconds: 300);
  static const readinessTween = Duration(milliseconds: 600);
  static const statusChange = Duration(milliseconds: 200);
  static const curve = Curves.easeOutCubic; // closest built-in to emphasizedDecelerate
}

/// Type scale (tokens.json `type`). Variable Inter: weights such as 650 are real, not rounded.
abstract final class VipType {
  static TextStyle _s(double size, double line, double weight) => TextStyle(
        fontFamily: 'Inter',
        fontSize: size,
        height: line / size,
        fontWeight: FontWeight.values[((weight / 100).round() - 1).clamp(0, 8)],
        fontVariations: [FontVariation('wght', weight)],
        fontFeatures: const [FontFeature.tabularFigures()],
      );

  static final display = _s(28, 34, 700);
  static final title = _s(20, 26, 650);
  static final headline = _s(17, 24, 600);
  static final body = _s(15, 22, 400);
  static final label = _s(13, 18, 550);
  static final caption = _s(12, 16, 500);

  /// OS font scale is honoured up to 1.3× (layouts must not clip at that size).
  static const double maxScale = 1.3;
}
