import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:visaitaly_pk/core/app_info.dart';
import 'package:visaitaly_pk/core/auth/auth_gateway.dart';
import 'package:visaitaly_pk/core/config/app_config.dart';
import 'package:visaitaly_pk/core/network/dio_client.dart';
import 'package:visaitaly_pk/core/providers.dart';

import 'fakes.dart';

const testConfig = AppConfig(flavor: Flavor.dev, apiBaseUrl: 'http://api.test');
const testAppInfo = AppInfo(platform: 'android', appVersion: '1.0.0');

/// A fake clock the test can move.
class Clock {
  Clock(this.now);
  DateTime now;
  DateTime call() => now;
}

class Harness {
  Harness(this.auth, this.adapter, this.clock, this.overrides);
  final FakeAuthGateway auth;
  final ScriptedAdapter adapter;
  final Clock clock;
  final List<dynamic> overrides;

  ProviderContainer container() {
    final c = ProviderContainer(retry: (_, _) => null, overrides: overrides.cast());
    return c;
  }

  Iterable<RequestOptions> requestsTo(String path) => adapter.requests.where((r) => r.path == path);
}

/// The real Dio/interceptor stack over a scripted adapter, a fake Firebase gateway and a fake clock.
Harness harness(Responder responder, {AuthUser? user}) {
  final auth = FakeAuthGateway(user: user);
  final adapter = ScriptedAdapter(responder);
  final clock = Clock(DateTime.utc(2026, 10, 14, 12));
  return Harness(auth, adapter, clock, [
    appConfigProvider.overrideWithValue(testConfig),
    authGatewayProvider.overrideWithValue(auth),
    appInfoProvider.overrideWithValue(testAppInfo),
    deviceIdStoreProvider.overrideWithValue(FakeDeviceIdStore()),
    clockProvider.overrideWithValue(clock.call),
    // Real interceptors; the terminator reaches the real SessionController.
    dioProvider.overrideWith((ref) => _dio(ref, auth, adapter)),
  ]);
}

Dio _dio(Ref ref, FakeAuthGateway auth, ScriptedAdapter adapter) => createDio(
      config: testConfig,
      auth: auth,
      device: FakeDeviceIdStore(),
      onTerminal: (code) => ref.read(sessionControllerProvider.notifier).terminate(code),
      adapter: adapter,
      sleep: (_) async {},
    );
