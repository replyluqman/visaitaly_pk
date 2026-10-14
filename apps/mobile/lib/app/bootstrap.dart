import 'package:firebase_auth/firebase_auth.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../core/app_info.dart';
import '../core/auth/auth_gateway.dart';
import '../core/config/app_config.dart';
import '../core/design/perf_tier.dart';
import '../core/providers.dart';
import 'app.dart';

/// Shared entry for every flavor. Firebase options come from the flavor's google-services.json.
Future<void> bootstrap(Flavor flavor) async {
  WidgetsFlutterBinding.ensureInitialized();
  final config = AppConfig.fromEnvironment(flavor);
  await Firebase.initializeApp();
  final pkg = await PackageInfo.fromPlatform();
  final android = await DeviceInfoPlugin().androidInfo;
  final a11y = WidgetsBinding.instance.platformDispatcher.accessibilityFeatures;

  runApp(ProviderScope(
    // Riverpod 3 retries failed providers by default; our controllers own their retry UX.
    retry: (_, _) => null,
    overrides: [
      appConfigProvider.overrideWithValue(config),
      authGatewayProvider.overrideWithValue(FirebaseAuthGateway(FirebaseAuth.instance)),
      deviceFactsProvider.overrideWithValue(DeviceFacts(
        ramMb: android.physicalRamSize,
        sdkInt: android.version.sdkInt,
        reduceMotion: a11y.disableAnimations,
        highContrast: a11y.highContrast,
      )),
      appInfoProvider.overrideWithValue(AppInfo(platform: 'android', appVersion: pkg.version, packageName: pkg.packageName)),
    ],
    child: const VisaItalyApp(),
  ));
}
