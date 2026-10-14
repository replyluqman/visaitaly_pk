/// What the session-registration call reports about this install.
class AppInfo {
  const AppInfo({required this.platform, required this.appVersion, this.packageName = 'pk.visaitaly.app', this.osVersion, this.model});
  final String platform; // 'android' | 'ios'
  final String appVersion;

  /// The installed application id (differs per flavor) — used to open this app's Play Store page.
  final String packageName;
  final String? osVersion;
  final String? model;
}
