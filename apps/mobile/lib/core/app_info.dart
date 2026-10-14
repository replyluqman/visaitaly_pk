/// What the session-registration call reports about this install.
class AppInfo {
  const AppInfo({required this.platform, required this.appVersion, this.osVersion, this.model});
  final String platform; // 'android' | 'ios'
  final String appVersion;
  final String? osVersion;
  final String? model;
}
