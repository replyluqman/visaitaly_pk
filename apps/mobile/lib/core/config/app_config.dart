enum Flavor { dev, staging, prod }

/// Per-flavor configuration. Nothing here is a secret: the API has no client secrets, and Firebase's
/// own options come from the flavor's google-services.json.
class AppConfig {
  const AppConfig({
    required this.flavor,
    required this.apiBaseUrl,
    this.requestTimeout = const Duration(seconds: 15),
    this.resumeRefreshAfter = const Duration(minutes: 30),
    this.maxRetries = 2,
  });

  final Flavor flavor;
  final String apiBaseUrl;
  final Duration requestTimeout;

  /// DECIDE (docs/FLUTTER-ARCHITECTURE.md): re-fetch GET /v1/me on resume after this long. 30 min suggested.
  final Duration resumeRefreshAfter;
  final int maxRetries;

  /// `--dart-define=API_BASE_URL=https://…` is required for staging and prod; dev falls back to the
  /// Android emulator's alias for the host running `wrangler dev`.
  factory AppConfig.fromEnvironment(Flavor flavor) {
    const defined = String.fromEnvironment('API_BASE_URL');
    final url = defined.isNotEmpty ? defined : (flavor == Flavor.dev ? 'http://10.0.2.2:8787' : '');
    if (url.isEmpty) {
      throw StateError('API_BASE_URL must be set with --dart-define for the ${flavor.name} flavor.');
    }
    return AppConfig(flavor: flavor, apiBaseUrl: url);
  }
}
