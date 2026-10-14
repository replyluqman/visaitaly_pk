import 'package:intl/intl.dart';

/// Calendar dates travel as `YYYY-MM-DD` strings. Parse them as a plain y/m/d — never through a UTC instant,
/// which would shift the day for users west of Greenwich — and format for display only.
DateTime? parseYmd(String? s) {
  if (s == null) return null;
  final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(s);
  if (m == null) return null;
  return DateTime(int.parse(m[1]!), int.parse(m[2]!), int.parse(m[3]!));
}

String formatYmd(String? s, String locale) {
  final d = parseYmd(s);
  return d == null ? (s ?? '') : DateFormat.yMMMd(locale).format(d);
}

/// Timestamps (ISO-8601 UTC) → local time for display.
DateTime? parseInstant(String? s) => s == null ? null : DateTime.tryParse(s)?.toLocal();

String formatInstant(String? s, String locale) {
  final d = parseInstant(s);
  return d == null ? '' : DateFormat.yMMMd(locale).add_jm().format(d);
}

String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(0)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}
