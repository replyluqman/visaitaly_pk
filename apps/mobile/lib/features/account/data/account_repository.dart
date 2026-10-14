import 'package:dio/dio.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors.dart';
import 'dto/account_dto.dart';

class AccountRepository {
  AccountRepository(this._dio);
  final Dio _dio;

  Future<Consents> consents() => apiCall(
        () => _dio.get<dynamic>('/v1/account/consents'),
        (j) => Consents.fromJson(j! as Map<String, dynamic>),
      );

  /// Consent is per purpose and revocable; the server stamps the policy version that was shown.
  Future<Consents> setConsents({bool? analytics, bool? crashReports, bool? marketingPush, required String policyVersion}) => apiCall(
        () => _dio.put<dynamic>(
          '/v1/account/consents',
          data: {'analytics': ?analytics, 'crashReports': ?crashReports, 'marketingPush': ?marketingPush, 'policyVersion': policyVersion},
          options: Options(extra: {Extra.idempotent: true}),
        ),
        (j) => Consents.fromJson(j! as Map<String, dynamic>),
      );

  Future<List<DeviceSummary>> devices() => apiCall(
        () => _dio.get<dynamic>('/v1/devices'),
        (j) => ((j! as Map<String, dynamic>)['devices'] as List).map((e) => DeviceSummary.fromJson(e as Map<String, dynamic>)).toList(),
      );

  Future<void> signOutDevice(String deviceId) => apiCall(() => _dio.delete<dynamic>('/v1/devices/$deviceId'), (_) {});

  Future<DataRequestAccepted> requestExport() => apiCall(
        () => _dio.post<dynamic>('/v1/account/data-export'),
        (j) => DataRequestAccepted.fromJson(j! as Map<String, dynamic>),
      );

  Future<DataExportStatus> exportStatus(String id) => apiCall(
        () => _dio.get<dynamic>('/v1/account/data-exports/$id'),
        (j) => DataExportStatus.fromJson(j! as Map<String, dynamic>),
      );

  /// Needs a Firebase sign-in at most 5 minutes old, else REAUTH_REQUIRED (re-authenticate, then call again).
  /// After a 202 every call answers USER_DELETED and the data is erased within minutes.
  Future<void> deleteAccount() => apiCall(
        () => _dio.delete<dynamic>('/v1/account', data: {'confirm': true}),
        (_) {},
      );
}
