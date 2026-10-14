import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../../core/models/enums.dart';
import '../../../core/network/capability_upload.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors.dart';
import '../../documents/data/dto/document_dto.dart';
import 'dto/support_dto.dart';

class SupportRepository {
  SupportRepository(this._dio);
  final Dio _dio;

  Future<SupportThreadView> thread({String locale = 'en'}) => apiCall(
        () => _dio.get<dynamic>('/v1/support/thread', queryParameters: {'locale': locale}),
        (j) => SupportThreadView.fromJson(j! as Map<String, dynamic>),
      );

  Future<SupportMessageList> messages({String? cursor, int limit = 30}) => apiCall(
        () => _dio.get<dynamic>('/v1/support/messages', queryParameters: {'limit': limit, 'cursor': ?cursor}),
        (j) => SupportMessageList.fromJson(j! as Map<String, dynamic>),
      );

  /// NOT retried and not idempotent on the server: a lost response followed by a retry would send the message twice.
  Future<SupportMessage> send({
    String body = '',
    required SupportTopic topic,
    String? applicantId,
    String? attachmentId,
  }) =>
      apiCall(
        () => _dio.post<dynamic>('/v1/support/messages', data: {
          'body': body,
          'topic': wire(topic),
          'applicantId': ?applicantId,
          'attachmentId': ?attachmentId,
        }),
        (j) => SupportMessage.fromJson(j! as Map<String, dynamic>),
      );

  /// Opening the thread marks the admin replies as read.
  Future<void> markRead() => apiCall(
        () => _dio.post<dynamic>('/v1/support/read', options: Options(extra: {Extra.idempotent: true})),
        (_) {},
      );

  /// Reserve + PUT an image (jpeg/png). Returns the attachment id to pass to [send].
  Future<String> uploadAttachment({required Uint8List bytes, required String mime}) async {
    final r = await apiCall(
      () => _dio.post<dynamic>('/v1/support/attachments/upload-url', data: {'mime': mime, 'sizeBytes': bytes.length}),
      (j) => UploadReservation.fromJson(j! as Map<String, dynamic>),
    );
    await putToCapabilityUrl(_dio, url: r.uploadUrl, bytes: bytes, requiredHeaders: r.requiredHeaders);
    return r.id;
  }

  Future<String> attachmentViewUrl(String id) => apiCall(
        () => _dio.get<dynamic>('/v1/support/attachments/$id'),
        (j) => (j! as Map<String, dynamic>)['url'] as String,
      );
}
