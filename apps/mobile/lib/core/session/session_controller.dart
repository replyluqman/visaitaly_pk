import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../network/api_error.dart';
import '../version.dart';
import '../../features/auth/data/dto/me_dto.dart';
import '../providers.dart';
import 'session_state.dart';

/// Owns the latest /v1/me snapshot. Sources (docs/FLUTTER-ARCHITECTURE.md):
///  - POST /v1/auth/session after every interactive sign-in,
///  - GET /v1/me on a cold start (Firebase restored the user) and on resume after a long pause.
/// Routing is derived from this state only — never from local flags.
class SessionController extends Notifier<SessionState> {
  StreamSubscription<dynamic>? _sub;
  bool _firstEvent = true;
  bool _terminating = false;
  bool _registerOnRetry = false;
  SignOutNotice? _pendingNotice;
  DateTime? _loadedAt;
  Future<void>? _inFlight;

  @override
  SessionState build() {
    final auth = ref.watch(authGatewayProvider);
    _sub = auth.authStateChanges().listen(_onAuth, onError: (Object _) => _setSignedOut());
    ref.onDispose(() => _sub?.cancel());
    return const SessionLoading();
  }

  Future<void> _onAuth(dynamic user) async {
    final first = _firstEvent;
    _firstEvent = false;
    if (user == null) {
      _setSignedOut();
      return;
    }
    if (state is SessionReady) return; // already loaded for this login
    // A user restored at app start is a cold start (/me); a user appearing later signed in interactively (register).
    await _load(register: !first);
  }

  void _setSignedOut() {
    _loadedAt = null;
    state = SessionSignedOut(notice: _pendingNotice);
    _pendingNotice = null;
  }

  Future<void> _load({required bool register}) {
    return _inFlight ??= () async {
      try {
        if (state is! SessionReady) state = const SessionLoading();
        final repo = ref.read(authRepositoryProvider);
        final MeResponse me;
        if (register) {
          final deviceId = await ref.read(deviceIdStoreProvider).getOrCreate();
          me = (await repo.registerSession(deviceId: deviceId, app: ref.read(appInfoProvider))).me;
        } else {
          me = await repo.getMe();
        }
        _registerOnRetry = false;
        _loadedAt = ref.read(clockProvider)();
        state = _readyOrUpdate(me);
      } on ApiError catch (e) {
        if (state is SessionSignedOut) return; // a terminal code already ended the session
        if (e.code == ApiCodes.appUpdateRequired) {
          state = const SessionUpdateRequired();
          return;
        }
        _registerOnRetry = register;
        state = SessionFailed(e);
      } finally {
        _inFlight = null;
      }
    }();
  }

  /// Ready, unless the snapshot says this build is below the server's minimum (ADR 0013).
  SessionState _readyOrUpdate(MeResponse me) {
    final min = me.app.minAppVersion;
    return isBelowMinimum(ref.read(appInfoProvider).appVersion, min) ? SessionUpdateRequired(min) : SessionReady(me);
  }

  /// Splash "Try again".
  Future<void> retry() => _load(register: _registerOnRetry);

  /// Re-fetch the snapshot after an action that changes it (accepted legal, added an applicant, set a stage…).
  /// Keeps the current state on a transient failure instead of dropping the user to an error screen.
  Future<void> refresh() async {
    try {
      final me = await ref.read(authRepositoryProvider).getMe();
      _loadedAt = ref.read(clockProvider)();
      if (state is SessionReady || state is SessionFailed || state is SessionUpdateRequired) state = _readyOrUpdate(me);
    } on ApiError {
      // terminal codes were already routed to terminate(); anything else keeps the last good snapshot
    }
  }

  /// On app resume: refresh if the snapshot is older than the configured window.
  Future<void> refreshIfStale() async {
    final at = _loadedAt;
    if (state is! SessionReady || at == null) return;
    final age = ref.read(clockProvider)().difference(at);
    if (age >= ref.read(appConfigProvider).resumeRefreshAfter) await refresh();
  }

  /// Called by the error interceptor for a session-terminal code. Single-flight: a burst of parallel 401s must
  /// not trigger several sign-outs.
  Future<void> terminate(String code) async {
    if (_terminating || state is SessionSignedOut) return;
    _terminating = true;
    _pendingNotice = noticeForCode(code);
    try {
      await ref.read(authGatewayProvider).signOut();
    } finally {
      _terminating = false;
    }
    if (state is! SessionSignedOut) _setSignedOut(); // the auth stream normally does this
  }

  /// User-initiated sign-out.
  Future<void> signOut() async {
    await ref.read(authGatewayProvider).signOut();
  }
}
