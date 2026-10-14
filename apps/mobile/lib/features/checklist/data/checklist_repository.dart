import 'package:dio/dio.dart';

import '../../../core/models/enums.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors.dart';
import 'dto/checklist_dto.dart';

class ChecklistFilter {
  const ChecklistFilter({this.status, this.blocking, this.translation, this.apostille});
  final ItemStatus? status;
  final bool? blocking;
  final bool? translation;
  final bool? apostille;

  bool get isEmpty => status == null && blocking == null && translation == null && apostille == null;

  ChecklistFilter copyWith({
    Object? status = _keep,
    Object? blocking = _keep,
    Object? translation = _keep,
    Object? apostille = _keep,
  }) =>
      ChecklistFilter(
        status: identical(status, _keep) ? this.status : status as ItemStatus?,
        blocking: identical(blocking, _keep) ? this.blocking : blocking as bool?,
        translation: identical(translation, _keep) ? this.translation : translation as bool?,
        apostille: identical(apostille, _keep) ? this.apostille : apostille as bool?,
      );

  @override
  bool operator ==(Object other) =>
      other is ChecklistFilter &&
      other.status == status &&
      other.blocking == blocking &&
      other.translation == translation &&
      other.apostille == apostille;

  @override
  int get hashCode => Object.hash(status, blocking, translation, apostille);

  static const _keep = Object();
}

class ChecklistRepository {
  ChecklistRepository(this._dio);
  final Dio _dio;

  Future<ChecklistResponse> list(
    String applicantId, {
    ChecklistFilter filter = const ChecklistFilter(),
    String? cursor,
    int limit = 20,
    String locale = 'en',
  }) =>
      apiCall(
        () => _dio.get<dynamic>('/v1/applicants/$applicantId/checklist', queryParameters: {
          'limit': limit,
          'locale': locale,
          'cursor': ?cursor,
          if (filter.status != null) 'status': wire(filter.status!),
          if (filter.blocking != null) 'blocking': filter.blocking,
          if (filter.translation != null) 'translation': filter.translation,
          if (filter.apostille != null) 'apostille': filter.apostille,
        }),
        (j) => ChecklistResponse.fromJson(j! as Map<String, dynamic>),
      );

  Future<ChecklistItemDetail> detail(String itemId, {String locale = 'en'}) => apiCall(
        () => _dio.get<dynamic>('/v1/checklist/$itemId', queryParameters: {'locale': locale}),
        (j) => ChecklistItemDetail.fromJson(j! as Map<String, dynamic>),
      );

  /// Online edit: no baseVersion / clientMutationAt (those are for the offline queue, which is not built).
  /// Idempotent — setting a status twice is the same as once.
  Future<ChecklistItem> setStatus(String itemId, ItemStatus status) => apiCall(
        () => _dio.patch<dynamic>(
          '/v1/checklist/$itemId',
          data: {'status': wire(status)},
          options: Options(extra: {Extra.idempotent: true}),
        ),
        (j) => ChecklistItem.fromJson(j! as Map<String, dynamic>),
      );

  Future<ChecklistItem> acknowledgeReview(String itemId) => apiCall(
        () => _dio.post<dynamic>('/v1/checklist/$itemId/acknowledge-review', options: Options(extra: {Extra.idempotent: true})),
        (j) => ChecklistItem.fromJson(j! as Map<String, dynamic>),
      );

  Future<JourneyResponse> journey(String applicantId) => apiCall(
        () => _dio.get<dynamic>('/v1/applicants/$applicantId/journey'),
        (j) => JourneyResponse.fromJson(j! as Map<String, dynamic>),
      );
}
