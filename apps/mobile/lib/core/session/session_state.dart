import '../../features/auth/data/dto/me_dto.dart';
import '../network/api_error.dart';

/// Why the user is on the Login screen — shown as a notice (Screens §3: "device-evicted notice").
enum SignOutNotice { deviceEvicted, deviceSignedOut, deviceUnknown, accountDeleted, sessionExpired }

SignOutNotice? noticeForCode(String code) => switch (code) {
      ApiCodes.deviceEvicted => SignOutNotice.deviceEvicted,
      ApiCodes.deviceSignedOut => SignOutNotice.deviceSignedOut,
      ApiCodes.deviceUnknown => SignOutNotice.deviceUnknown,
      ApiCodes.userDeleted => SignOutNotice.accountDeleted,
      ApiCodes.unauthenticated => SignOutNotice.sessionExpired,
      _ => null,
    };

sealed class SessionState {
  const SessionState();
}

/// Resolving the Firebase session / fetching the snapshot (Splash).
class SessionLoading extends SessionState {
  const SessionLoading();
}

class SessionSignedOut extends SessionState {
  const SessionSignedOut({this.notice});
  final SignOutNotice? notice;
}

/// The snapshot could not be fetched for a non-terminal reason (offline, 5xx). Splash offers retry.
class SessionFailed extends SessionState {
  const SessionFailed(this.error);
  final ApiError error;
}

class SessionReady extends SessionState {
  const SessionReady(this.me);
  final MeResponse me;
}
