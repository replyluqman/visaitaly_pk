/**
 * Canonical API error codes. Shared by API + CMS, mirrored manually in Flutter.
 * Clients branch on `code`, never on `message`.
 */
export const ErrorCode = {
  // auth / session
  UNAUTHENTICATED: 'UNAUTHENTICATED',             // 401 missing/invalid/expired Firebase token
  DEVICE_HEADER_MISSING: 'DEVICE_HEADER_MISSING', // 400 X-Device-Id absent
  DEVICE_UNKNOWN: 'DEVICE_UNKNOWN',               // 401 device never registered for this user
  DEVICE_EVICTED: 'DEVICE_EVICTED',               // 401 evicted by the 2-device rule (PRD §2)
  DEVICE_SIGNED_OUT: 'DEVICE_SIGNED_OUT',         // 401 remotely signed out from Account screen
  USER_DELETED: 'USER_DELETED',                   // 403 GDPR-deleted account

  // domain — added in Module 2
  APPLICANT_LIMIT_REACHED: 'APPLICANT_LIMIT_REACHED',   // 409 CMS-driven cap reached
  APPLICANT_READ_ONLY: 'APPLICANT_READ_ONLY',           // 403 grace_read_only / expired (PRD §7)
  LEGAL_ACCEPTANCE_REQUIRED: 'LEGAL_ACCEPTANCE_REQUIRED', // 403 current version not accepted (§18)
  ONBOARDING_STEP_INVALID: 'ONBOARDING_STEP_INVALID',     // 409 step attempted out of order

  // domain — added in Module 3
  PREMIUM_REQUIRED: 'PREMIUM_REQUIRED',           // 402 item beyond the free preview
  CHECKLIST_CONFLICT: 'CHECKLIST_CONFLICT',       // 409 offline mutation hit a changed item (PRD §12)

  // domain — added in Module 3b
  UPLOAD_TOO_LARGE: 'UPLOAD_TOO_LARGE',           // 413 file over the per-file cap
  UPLOAD_QUOTA_EXCEEDED: 'UPLOAD_QUOTA_EXCEEDED', // 413 user storage quota would be exceeded
  UPLOAD_REJECTED: 'UPLOAD_REJECTED',             // 422 uploaded object failed size/type verification

  // support — added in Module 8
  SUPPORT_TOPIC_NOT_ALLOWED: 'SUPPORT_TOPIC_NOT_ALLOWED', // 403 topic not available on this account's tier (PRD §8/§10)

  // account — added in Module 10a
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',             // 401 destructive action needs a fresh sign-in (auth_time too old)

  // admin — added in Module 4a
  ADMIN_FORBIDDEN: 'ADMIN_FORBIDDEN',             // 403 not an active admin, or missing the required scope
  ADMIN_MFA_REQUIRED: 'ADMIN_MFA_REQUIRED',       // 403 admin token lacks a second factor

  // generic
  VALIDATION_FAILED: 'VALIDATION_FAILED',         // 422
  NOT_FOUND: 'NOT_FOUND',                         // 404
  CONFLICT: 'CONFLICT',                           // 409
  RATE_LIMITED: 'RATE_LIMITED',                   // 429
  INTERNAL: 'INTERNAL',                           // 500
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Every non-2xx response has exactly this shape. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level detail, only present for VALIDATION_FAILED. */
    details?: Record<string, string[]>;
    requestId: string;
  };
}

/**
 * Codes meaning: wipe local session, route to Login, show a notice.
 * The Flutter Dio interceptor keys off this exact set.
 */
export const SESSION_TERMINAL_CODES: readonly ErrorCode[] = [
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.DEVICE_UNKNOWN,
  ErrorCode.DEVICE_EVICTED,
  ErrorCode.DEVICE_SIGNED_OUT,
  ErrorCode.USER_DELETED,
] as const;
