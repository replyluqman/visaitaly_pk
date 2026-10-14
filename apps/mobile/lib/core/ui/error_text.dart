import '../l10n/app_localizations.dart';
import '../network/api_error.dart';
import '../auth/auth_gateway.dart';

/// User-facing text for a failure. Branches on the error CODE, never on the server's message.
String errorText(AppLocalizations l, Object error) {
  if (error is AuthFailure) {
    return switch (error.reason) {
      AuthFailureReason.invalidCredentials => l.authInvalidCredentials,
      AuthFailureReason.userDisabled => l.authUserDisabled,
      AuthFailureReason.emailInUse => l.authEmailInUse,
      AuthFailureReason.weakPassword => l.authWeakPassword,
      AuthFailureReason.invalidEmail => l.authInvalidEmail,
      AuthFailureReason.tooManyRequests => l.authTooManyRequests,
      AuthFailureReason.network => l.errorNetwork,
      AuthFailureReason.unknown => l.errorGeneric,
    };
  }
  if (error is ApiError) {
    switch (error.code) {
      case ApiCodes.network:
        return l.errorNetwork;
      case ApiCodes.applicantReadOnly:
        return l.errorReadOnly;
      case ApiCodes.applicantLimitReached:
        return l.errorApplicantLimit;
      case ApiCodes.validationFailed:
        return l.errorValidation;
      default:
        final ref = error.requestId;
        return ref == null ? l.errorGeneric : l.errorWithRef(l.errorGeneric, ref);
    }
  }
  return l.errorGeneric;
}

/// Server field errors (`details`), flattened to one message per field. The server's wording is display text
/// only; which field is wrong comes from the key.
Map<String, String> fieldErrors(Object error) {
  if (error is! ApiError || error.code != ApiCodes.validationFailed) return const {};
  return {for (final e in error.details.entries) if (e.value.isNotEmpty) e.key: e.value.first};
}
