import 'dart:typed_data';

import 'package:dio/dio.dart';

import 'dio_client.dart';
import 'interceptors.dart';

/// PUT raw bytes to a signed capability URL (documents, support attachments).
///
/// These URLs carry their own signature: NO session token and NO device header may be attached (that would leak
/// the Firebase token to a URL the server merely minted), and the headers the server listed in `requiredHeaders`
/// are sent exactly as given, with an explicit Content-Length. Not retried — the reservation is single-use.
Future<void> putToCapabilityUrl(
  Dio dio, {
  required String url,
  required Uint8List bytes,
  required Map<String, String> requiredHeaders,
}) =>
    apiCall(
      () => dio.put<dynamic>(
        url,
        data: Stream.value(bytes),
        options: Options(
          headers: {...requiredHeaders, Headers.contentLengthHeader: bytes.length},
          contentType: requiredHeaders['Content-Type'],
          extra: {Extra.noAuth: true, Extra.noDevice: true},
          responseType: ResponseType.plain,
        ),
      ),
      (_) {},
    );

/// GET bytes from a signed view URL (no session).
Future<Uint8List> getFromCapabilityUrl(Dio dio, String url) => apiCall(
      () => dio.get<List<int>>(
        url,
        options: Options(responseType: ResponseType.bytes, extra: {Extra.noAuth: true, Extra.noDevice: true}),
      ),
      (data) => Uint8List.fromList((data! as List).cast<int>()),
    );
