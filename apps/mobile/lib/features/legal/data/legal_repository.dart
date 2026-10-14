import 'package:dio/dio.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors.dart';
import 'dto/legal_dto.dart';

class LegalRepository {
  LegalRepository(this._dio);
  final Dio _dio;

  Future<CurrentLegalResponse> current({String locale = 'en'}) => apiCall(
        () => _dio.get<dynamic>('/v1/legal/current', queryParameters: {'locale': locale}),
        (j) => CurrentLegalResponse.fromJson(j! as Map<String, dynamic>),
      );

  Future<LegalDocumentResponse> document(String docType, {String locale = 'en'}) => apiCall(
        () => _dio.get<dynamic>('/v1/legal/current/$docType', queryParameters: {'locale': locale}),
        (j) => LegalDocumentResponse.fromJson(j! as Map<String, dynamic>),
      );

  /// Send the version ids that were DISPLAYED. A version published meanwhile makes the server answer 422;
  /// the caller reloads and shows the new text. Re-accepting is a harmless no-op, so this is idempotent.
  Future<void> accept(List<String> versionIds, {String? appVersion}) => apiCall(
        () => _dio.post<dynamic>(
          '/v1/legal/accept',
          data: {'versionIds': versionIds, 'appVersion': ?appVersion},
          options: Options(extra: {Extra.idempotent: true}),
        ),
        (_) {},
      );
}
