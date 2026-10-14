import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Device-local UX preferences only. Nothing here is account state or entitlement: the server is the truth for
/// those. (A "have we shown the Quick Check yet" flag only decides which screen a signed-out user sees first.)
abstract class SettingsStore {
  bool get reduceEffects;
  Future<void> setReduceEffects(bool v);
  bool get seenQuickCheck;
  Future<void> setSeenQuickCheck(bool v);
}

class SharedPrefsSettingsStore implements SettingsStore {
  SharedPrefsSettingsStore(this._p);
  final SharedPreferences _p;

  @override
  bool get reduceEffects => _p.getBool('reduce_effects') ?? false;
  @override
  Future<void> setReduceEffects(bool v) => _p.setBool('reduce_effects', v);
  @override
  bool get seenQuickCheck => _p.getBool('seen_quick_check') ?? false;
  @override
  Future<void> setSeenQuickCheck(bool v) => _p.setBool('seen_quick_check', v);
}

class MemorySettingsStore implements SettingsStore {
  MemorySettingsStore({this.reduceEffects = false, this.seenQuickCheck = true});
  @override
  bool reduceEffects;
  @override
  bool seenQuickCheck;
  @override
  Future<void> setReduceEffects(bool v) async => reduceEffects = v;
  @override
  Future<void> setSeenQuickCheck(bool v) async => seenQuickCheck = v;
}

/// Overridden with the real store at startup. The default is in-memory with the Quick Check already "seen", so a
/// test (or a missing override) never silently routes signed-out users to a different first screen.
final settingsStoreProvider = Provider<SettingsStore>((ref) => MemorySettingsStore());

/// Whether the pre-auth Quick Check should be offered first (first open, no session). Flips once it was shown.
class FirstOpenController extends Notifier<bool> {
  @override
  bool build() => !ref.read(settingsStoreProvider).seenQuickCheck;

  Future<void> markSeen() async {
    await ref.read(settingsStoreProvider).setSeenQuickCheck(true);
    state = false;
  }
}

final firstOpenProvider = NotifierProvider<FirstOpenController, bool>(FirstOpenController.new);
