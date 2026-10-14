import 'package:dio/dio.dart';

import '../../../core/network/dio_client.dart';
import '../../documents/data/dto/document_dto.dart';

class TodayRepository {
  TodayRepository(this._dio);
  final Dio _dio;

  /// Premium only (grace is readable): free/expired → PREMIUM_REQUIRED.
  Future<TodayResponse> today({String locale = 'en'}) => apiCall(
        () => _dio.get<dynamic>('/v1/today', queryParameters: {'locale': locale}),
        (j) => TodayResponse.fromJson(j! as Map<String, dynamic>),
      );
}
