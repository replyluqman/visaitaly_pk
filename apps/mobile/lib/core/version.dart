/// Mirror of apps/api/src/lib/version.ts — keep the two in step. Fails OPEN: an unparsable version is never "too old".
List<int>? parseVersion(String v) {
  final m = RegExp(r'^(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:[-+].*)?$').firstMatch(v.trim());
  if (m == null) return null;
  return [for (var i = 1; i <= 4; i++) int.parse(m.group(i) ?? '0')];
}

/// True only when [appVersion] is clearly older than [minVersion].
bool isBelowMinimum(String appVersion, String minVersion) {
  final a = parseVersion(appVersion);
  final b = parseVersion(minVersion);
  if (a == null || b == null) return false;
  for (var i = 0; i < 4; i++) {
    if (a[i] != b[i]) return a[i] < b[i];
  }
  return false;
}
