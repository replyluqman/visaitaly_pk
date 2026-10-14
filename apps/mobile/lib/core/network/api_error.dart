import 'dart:convert';

import 'package:dio/dio.dart';

/// Error codes are the contract: branch on [ApiError.code], never on the message (docs/API-CONTRACT.md).
abstract final class ApiCodes {
  static const unauthenticated = 'UNAUTHENTICATED';
  static const deviceUnknown = 'DEVICE_UNKNOWN';
  static const deviceEvicted = 'DEVICE_EVICTED';
  static const deviceSignedOut = 'DEVICE_SIGNED_OUT';
  static const userDeleted = 'USER_DELETED';
  static const legalAcceptanceRequired = 'LEGAL_ACCEPTANCE_REQUIRED';
  static const onboardingStepInvalid = 'ONBOARDING_STEP_INVALID';
  static const applicantLimitReached = 'APPLICANT_LIMIT_REACHED';
  static const applicantReadOnly = 'APPLICANT_READ_ONLY';
  static const validationFailed = 'VALIDATION_FAILED';
  static const notFound = 'NOT_FOUND';
  static const conflict = 'CONFLICT';
  static const rateLimited = 'RATE_LIMITED';
  static const appUpdateRequired = 'APP_UPDATE_REQUIRED';
  static const premiumRequired = 'PREMIUM_REQUIRED';
  static const checklistConflict = 'CHECKLIST_CONFLICT';
  static const uploadTooLarge = 'UPLOAD_TOO_LARGE';
  static const uploadQuotaExceeded = 'UPLOAD_QUOTA_EXCEEDED';
  static const uploadRejected = 'UPLOAD_REJECTED';
  static const supportTopicNotAllowed = 'SUPPORT_TOPIC_NOT_ALLOWED';
  static const reauthRequired = 'REAUTH_REQUIRED';
  static const internal = 'INTERNAL';

  /// Client-only: no response was received (offline, timeout, DNS).
  static const network = 'NETWORK';

  /// Codes that end the session immediately, with no retry (UNAUTHENTICATED is handled separately: refresh once first).
  static const terminal = {deviceUnknown, deviceEvicted, deviceSignedOut, userDeleted};

  /// Every code the server is documented to send. Anything else is treated as [internal].
  static const known = {
    unauthenticated, deviceUnknown, deviceEvicted, deviceSignedOut, userDeleted, legalAcceptanceRequired,
    onboardingStepInvalid, applicantLimitReached, applicantReadOnly, validationFailed, notFound, conflict,
    rateLimited, appUpdateRequired, internal, 'DEVICE_HEADER_MISSING', 'PREMIUM_REQUIRED', 'CHECKLIST_CONFLICT',
    'UPLOAD_TOO_LARGE', 'UPLOAD_QUOTA_EXCEEDED', 'UPLOAD_REJECTED', 'SUPPORT_TOPIC_NOT_ALLOWED', 'REAUTH_REQUIRED',
  };
}

class ApiError implements Exception {
  const ApiError({
    required this.code,
    required this.message,
    this.details = const {},
    this.requestId,
    this.status = 0,
  });

  final String code;
  final String message;

  /// Field → messages, present only for VALIDATION_FAILED.
  final Map<String, List<String>> details;
  final String? requestId;
  final int status;

  bool get isNetwork => code == ApiCodes.network;
  bool get isTerminal => ApiCodes.terminal.contains(code);

  /// Maps a Dio failure onto the shared error body. A body that is not the contract's shape, or carries an
  /// unknown code, becomes INTERNAL — the client never crashes on a new server code.
  factory ApiError.fromDio(DioException e) {
    final res = e.response;
    if (res == null) {
      return ApiError(code: ApiCodes.network, message: 'No connection.', requestId: null);
    }
    var data = res.data;
    // Requests made with ResponseType.plain / bytes (signed-URL transfers) deliver the error body undecoded.
    if (data is String) {
      try {
        data = jsonDecode(data);
      } on FormatException {
        // not JSON (e.g. an HTML error page from a proxy) — handled as a non-contract body below
      }
    }
    final body = data is Map ? data['error'] : null;
    if (body is Map) {
      final raw = body['code'];
      final code = raw is String && ApiCodes.known.contains(raw) ? raw : ApiCodes.internal;
      final details = <String, List<String>>{};
      final d = body['details'];
      if (d is Map) {
        d.forEach((k, v) {
          if (v is List) details['$k'] = v.map((x) => '$x').toList();
        });
      }
      return ApiError(
        code: code,
        message: body['message'] is String ? body['message'] as String : 'Something went wrong.',
        details: details,
        requestId: body['requestId'] is String ? body['requestId'] as String : res.headers.value('x-request-id'),
        status: res.statusCode ?? 0,
      );
    }
    return ApiError(
      code: ApiCodes.internal,
      message: 'Something went wrong.',
      requestId: res.headers.value('x-request-id'),
      status: res.statusCode ?? 0,
    );
  }

  @override
  String toString() => 'ApiError($code, $status, $requestId)';
}
