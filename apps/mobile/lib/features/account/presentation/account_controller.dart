import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_gateway.dart';
import '../../../core/network/api_error.dart';
import '../../../core/providers.dart';
import '../../legal/data/dto/legal_dto.dart';
import '../../notifications/data/dto/notification_dto.dart';
import '../data/dto/account_dto.dart';

final consentsProvider = FutureProvider.autoDispose<Consents>((ref) => ref.watch(accountRepositoryProvider).consents());
final devicesProvider = FutureProvider.autoDispose<List<DeviceSummary>>((ref) => ref.watch(accountRepositoryProvider).devices());
final pushPrefsProvider =
    FutureProvider.autoDispose<NotificationPreferences>((ref) => ref.watch(notificationsRepositoryProvider).preferences());
final currentLegalProvider = FutureProvider.autoDispose<CurrentLegalResponse>((ref) => ref.watch(legalRepositoryProvider).current());

final exportStatusProvider = FutureProvider.autoDispose.family<DataExportStatus, String>(
  (ref, id) => ref.watch(accountRepositoryProvider).exportStatus(id),
);

enum DeleteOutcome { done, needsReauth, wrongPassword, failed }

class AccountActions extends AsyncNotifier<void> {
  /// The export request currently being tracked (null = none requested in this session).
  String? exportRequestId;

  @override
  void build() {}

  /// The privacy document version the user is shown when they decide — what a consent is stamped with.
  Future<String> _policyVersion() async {
    final legal = await ref.read(currentLegalProvider.future);
    final privacy = legal.documents.where((d) => d.docType.name == 'privacy').firstOrNull;
    return (privacy ?? legal.documents.firstOrNull)?.version ?? ref.read(appInfoProvider).appVersion;
  }

  Future<void> setConsent({bool? analytics, bool? crashReports, bool? marketingPush}) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref.read(accountRepositoryProvider).setConsents(
            analytics: analytics,
            crashReports: crashReports,
            marketingPush: marketingPush,
            policyVersion: await _policyVersion(),
          );
      ref.invalidate(consentsProvider);
    });
  }

  Future<void> setPush({bool? reminder, bool? update, bool? activity}) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref.read(notificationsRepositoryProvider).setPush(reminder: reminder, update: update, activity: activity);
      ref.invalidate(pushPrefsProvider);
    });
  }

  Future<void> signOutDevice(String deviceId) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref.read(accountRepositoryProvider).signOutDevice(deviceId);
      ref.invalidate(devicesProvider);
    });
  }

  Future<void> requestExport() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final r = await ref.read(accountRepositoryProvider).requestExport();
      exportRequestId = r.requestId;
    });
  }

  /// Deleting needs a fresh sign-in. First try as-is; if the server says REAUTH_REQUIRED the screen collects the
  /// password, we re-authenticate with Firebase and call again with the same flow.
  Future<DeleteOutcome> deleteAccount({String? password}) async {
    state = const AsyncLoading();
    try {
      if (password != null) await ref.read(authGatewayProvider).reauthenticate(password);
      await ref.read(accountRepositoryProvider).deleteAccount();
      state = const AsyncData(null);
      // After the 202 every call answers USER_DELETED; end the local session now rather than wait for that.
      await ref.read(sessionControllerProvider.notifier).signOut();
      return DeleteOutcome.done;
    } on ApiError catch (e) {
      state = AsyncError(e, StackTrace.current);
      return e.code == ApiCodes.reauthRequired ? DeleteOutcome.needsReauth : DeleteOutcome.failed;
    } on AuthFailure catch (e) {
      state = AsyncError(e, StackTrace.current);
      return e.reason == AuthFailureReason.invalidCredentials ? DeleteOutcome.wrongPassword : DeleteOutcome.failed;
    }
  }
}

final accountActionsProvider = AsyncNotifierProvider.autoDispose<AccountActions, void>(AccountActions.new);
