import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app_info.dart';
import 'auth/auth_gateway.dart';
import 'config/app_config.dart';
import 'network/dio_client.dart';
import 'session/session_controller.dart';
import 'session/session_state.dart';
import 'storage/device_id_store.dart';
import '../features/applicants/data/applicants_repository.dart';
import '../features/auth/data/auth_repository.dart';
import '../features/legal/data/legal_repository.dart';

// Provided by `bootstrap()` (real) or by tests (fakes).
final appConfigProvider = Provider<AppConfig>((ref) => throw UnimplementedError('override appConfigProvider'));
final authGatewayProvider = Provider<AuthGateway>((ref) => throw UnimplementedError('override authGatewayProvider'));
final appInfoProvider = Provider<AppInfo>((ref) => throw UnimplementedError('override appInfoProvider'));
final deviceIdStoreProvider = Provider<DeviceIdStore>((ref) => SecureDeviceIdStore());
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

final sessionControllerProvider = NotifierProvider<SessionController, SessionState>(SessionController.new);
