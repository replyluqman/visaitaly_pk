import 'dart:ui' show FrameTiming;

import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Visual-effects budget (DESIGN-SYSTEM.md §4). Decided once at startup and overridable in Settings.
///  full  — blur allowed per the glass rules
///  lite  — no blur anywhere; glass becomes the unblurred tint; static mesh kept
///  solid — solid surfaces, no mesh, fades only
enum PerfTier { full, lite, solid }

class DeviceFacts {
  const DeviceFacts({this.ramMb, this.sdkInt, this.reduceMotion = false, this.highContrast = false});
  final int? ramMb;
  final int? sdkInt;
  final bool reduceMotion;
  final bool highContrast;
}

/// `full` needs ≥ 4 GB RAM and Android ≥ 10 (API 29). Unknown facts degrade to `lite`, never to `full`:
/// a low-end phone mistaken for a flagship janks, the reverse merely looks plainer.
PerfTier decideTier(DeviceFacts f, {int fullMinRamMb = 4096, int fullMinSdk = 29}) {
  if (f.reduceMotion || f.highContrast) return PerfTier.solid;
  final ram = f.ramMb;
  final sdk = f.sdkInt;
  if (ram == null || sdk == null) return PerfTier.lite;
  // Android reports slightly under the marketed size (a "4 GB" phone shows ~3.7 GB), so allow a 10% margin.
  if (ram < fullMinRamMb * 0.9 || sdk < fullMinSdk) return PerfTier.lite;
  return PerfTier.full;
}

/// Counts slow frames over a sample window. > [threshold] of [sampleSize] frames over 16 ms ⇒ downgrade (once).
class FrameDropMonitor {
  FrameDropMonitor({this.sampleSize = 120, this.threshold = 0.10, this.slowMs = 16, required this.onDowngrade});
  final int sampleSize;
  final double threshold;
  final int slowMs;
  final void Function() onDowngrade;
  int _seen = 0;
  int _slow = 0;
  bool _fired = false;

  void onTimings(List<FrameTiming> timings) => addDurationsMs(timings.map((t) => t.totalSpan.inMilliseconds));

  void addDurationsMs(Iterable<int> ms) {
    if (_fired) return;
    for (final d in ms) {
      _seen++;
      if (d > slowMs) _slow++;
      if (_seen >= sampleSize) {
        if (_slow / _seen > threshold) {
          _fired = true;
          onDowngrade();
          return;
        }
        _seen = 0;
        _slow = 0;
      }
    }
  }
}

/// What the device can do. Overridden at startup (bootstrap); the default is the safe `lite`.
final deviceFactsProvider = Provider<DeviceFacts>((ref) => const DeviceFacts());

/// The tier in force. Starts at what the device allows; Settings can force `solid` ("Reduce visual effects")
/// and the frame monitor can only ever lower it.
class PerfTierController extends Notifier<PerfTier> {
  PerfTier _detected = PerfTier.lite;
  bool _userReduced = false;

  @override
  PerfTier build() => _detected = decideTier(ref.read(deviceFactsProvider));

  void setDetected(PerfTier t) {
    _detected = t;
    _apply();
  }

  void setUserReduced(bool v) {
    _userReduced = v;
    _apply();
  }

  /// Frame-drop downgrade: full → lite for the session. Never raises the tier.
  void downgradeToLite() {
    if (_detected == PerfTier.full) _detected = PerfTier.lite;
    _apply();
  }

  void _apply() => state = _userReduced ? PerfTier.solid : _detected;
}

final perfTierProvider = NotifierProvider<PerfTierController, PerfTier>(PerfTierController.new);
