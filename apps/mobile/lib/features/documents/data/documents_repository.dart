import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';

import '../../../core/network/capability_upload.dart';
import '../../../core/network/dio_client.dart';
import 'dto/document_dto.dart';

class DocumentsRepository {
  DocumentsRepository(this._dio);
  final Dio _dio;

  Future<DocumentList> list({String? applicantId, String? cursor, int limit = 20}) => apiCall(
        () => _dio.get<dynamic>('/v1/documents', queryParameters: {
          'limit': limit,
          'applicantId': ?applicantId,
          'cursor': ?cursor,
        }),
        (j) => DocumentList.fromJson(j! as Map<String, dynamic>),
      );

  /// Detail includes the short-lived `viewUrl`.
  Future<DocumentDto> detail(String id) => apiCall(
        () => _dio.get<dynamic>('/v1/documents/$id'),
        (j) => DocumentDto.fromJson(j! as Map<String, dynamic>),
      );

  Future<void> delete(String id) => apiCall(() => _dio.delete<dynamic>('/v1/documents/$id'), (_) {});

  Future<Uint8List> download(String viewUrl) => getFromCapabilityUrl(_dio, viewUrl);

  /// Reserve → PUT bytes (signed URL, no session) → complete. Until `complete` succeeds the file does not exist
  /// for any other call, so a failure at any step leaves nothing behind that the user can see.
  Future<DocumentDto> upload({
    required String applicantId,
    required Uint8List bytes,
    required String mime,
    String? checklistItemId,
    String? expiryDate,
  }) async {
    final reservation = await apiCall(
      () => _dio.post<dynamic>('/v1/documents/upload-url', data: {
        'mime': mime,
        'sizeBytes': bytes.length,
        'sha256': sha256.convert(bytes).toString(),
        'applicantId': applicantId,
        'checklistItemId': ?checklistItemId,
        'expiryDate': ?expiryDate,
      }),
      (j) => UploadReservation.fromJson(j! as Map<String, dynamic>),
    );
    await putToCapabilityUrl(_dio, url: reservation.uploadUrl, bytes: bytes, requiredHeaders: reservation.requiredHeaders);
    return apiCall(
      () => _dio.post<dynamic>('/v1/documents/${reservation.id}/complete'),
      (j) => DocumentDto.fromJson(j! as Map<String, dynamic>),
    );
  }
}
