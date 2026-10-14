import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app_info.dart';
import 'auth/auth_gateway.dart';
import 'config/app_config.dart';
import 'network/dio_client.dart';
import 'session/session_controller.dart';
import 'session/session_state.dart';
import 'storage/device_id_store.dart';
import '../features/account/data/account_repository.dart';
import '../features/applicants/data/applicants_repository.dart';
import '../features/checklist/data/checklist_repository.dart';
import '../features/documents/data/documents_repository.dart';
import '../features/notifications/data/notifications_repository.dart';
import '../features/public/data/public_repository.dart';
import '../features/support/data/support_repository.dart';
import '../features/today/data/today_repository.dart';
import '../features/auth/data/auth_repository.dart';
import '../features/legal/data/legal_repository.dart';

// Provided by `bootstrap()` (real) or by tests (fakes).
final appConfigProvider = Provider<AppConfig>((ref) => throw UnimplementedError('override appConfigProvider'));
final authGatewayProvider = Provider<AuthGateway>((ref) => throw UnimplementedError('override authGatewayProvider'));
final appInfoProvider = Provider<AppInfo>((ref) => throw UnimplementedError('override appInfoProvider'));
final deviceIdStoreProvider = Provider<DeviceIdStore>((ref) => SecureDeviceIdStore());
/// Opens an external URL. Injected so tests don't need a platform channel.
final urlOpenerProvider = Provider<Future<bool> Function(Uri)>((ref) => (uri) => launchUrl(uri, mode: LaunchMode.externalApplication));
final clockProvider = Provider<DateTime Function()>((ref) => DateTime.now);

/// The single Dio. The terminator reads the session controller lazily (at call time) so the providers do not form a cycle.
final dioProvider = Provider<Dio>((ref) {
  return createDio(
    config: ref.watch(appConfigProvider),
    auth: ref.watch(authGatewayProvider),
    device: ref.watch(deviceIdStoreProvider),
    onTerminal: (code) => ref.read(sessionControllerProvider.notifier).terminate(code),
  );
});

final authRepositoryProvider = Provider((ref) => AuthRepository(ref.watch(dioProvider)));
final legalRepositoryProvider = Provider((ref) => LegalRepository(ref.watch(dioProvider)));
final applicantsRepositoryProvider = Provider((ref) => ApplicantsRepository(ref.watch(dioProvider)));

final checklistRepositoryProvider = Provider((ref) => ChecklistRepository(ref.watch(dioProvider)));
final documentsRepositoryProvider = Provider((ref) => DocumentsRepository(ref.watch(dioProvider)));
final todayRepositoryProvider = Provider((ref) => TodayRepository(ref.watch(dioProvider)));
final notificationsRepositoryProvider = Provider((ref) => NotificationsRepository(ref.watch(dioProvider)));
final supportRepositoryProvider = Provider((ref) => SupportRepository(ref.watch(dioProvider)));
final accountRepositoryProvider = Provider((ref) => AccountRepository(ref.watch(dioProvider)));
final publicRepositoryProvider = Provider((ref) => PublicRepository(ref.watch(dioProvider)));

final sessionControllerProvider = NotifierProvider<SessionController, SessionState>(SessionController.new);
