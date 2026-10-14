import 'package:flutter/material.dart';

import 'tokens.dart';

ThemeData buildTheme(Brightness b) {
  final p = b == Brightness.light ? VipPalette.light : VipPalette.dark;
  final scheme = ColorScheme(
    brightness: b,
    primary: p.lagoon,
    onPrimary: p.textOnBrand,
    secondary: p.terracotta,
    onSecondary: p.textOnBrand,
    tertiary: p.indigo,
    onTertiary: p.textOnBrand,
    error: p.statusIssueFound,
    onError: p.textOnBrand,
    surface: p.surfaceSolid,
    onSurface: p.textPrimary,
    onSurfaceVariant: p.textSecondary,
    outline: p.strokeHairline,
    outlineVariant: p.strokeHairline,
    errorContainer: p.statusIssueFound.withValues(alpha: 0.14),
    onErrorContainer: p.statusIssueFound,
    secondaryContainer: p.lagoon.withValues(alpha: 0.14),
    onSecondaryContainer: p.textPrimary,
  );

  final text = TextTheme(
    displaySmall: VipType.display,
    titleLarge: VipType.title,
    titleMedium: VipType.headline,
    bodyLarge: VipType.body,
    bodyMedium: VipType.body,
    bodySmall: VipType.caption,
    labelLarge: VipType.label,
    labelMedium: VipType.label,
    labelSmall: VipType.caption,
    headlineMedium: VipType.display,
    headlineSmall: VipType.title,
  ).apply(bodyColor: p.textPrimary, displayColor: p.textPrimary);

  return ThemeData(
    useMaterial3: true,
    brightness: b,
    fontFamily: 'Inter',
    colorScheme: scheme,
    scaffoldBackgroundColor: Colors.transparent, // the mesh sits behind every screen
    canvasColor: p.surfaceSolid,
    textTheme: text,
    extensions: [p],
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleTextStyle: VipType.title.copyWith(color: p.textPrimary),
      foregroundColor: p.textPrimary,
    ),
    cardTheme: CardThemeData(
      color: p.surfaceTint,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Rad.lg),
        side: BorderSide(color: p.strokeGlass),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Rad.md)),
        textStyle: VipType.headline,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(48, 48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Rad.md)),
        side: BorderSide(color: p.strokeHairline),
        textStyle: VipType.headline,
      ),
    ),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(minimumSize: const Size(48, 48))),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.surfaceTint,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(Rad.md), borderSide: BorderSide(color: p.strokeHairline)),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Rad.md), borderSide: BorderSide(color: p.strokeHairline)),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: Colors.transparent,
      indicatorColor: p.lagoon.withValues(alpha: 0.16),
      labelTextStyle: WidgetStatePropertyAll(VipType.caption.copyWith(color: p.textPrimary)),
    ),
    dividerTheme: DividerThemeData(color: p.strokeHairline, space: 1),
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.android: FadeForwardsPageTransitionsBuilder(),
    }),
  );
}
