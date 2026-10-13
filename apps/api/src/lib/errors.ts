import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ErrorCode, type ApiErrorBody } from '@visaitaly/shared';

/**
 * One table, so a code can never be thrown with two different statuses.
 * `Record<ErrorCode, …>` makes adding a code without a status a compile error.
 */
const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  UNAUTHENTICATED: 401,
  DEVICE_HEADER_MISSING: 400,
  DEVICE_UNKNOWN: 401,
  DEVICE_EVICTED: 401,
  DEVICE_SIGNED_OUT: 401,
  USER_DELETED: 403,
  LEGAL_ACCEPTANCE_REQUIRED: 403,
  ONBOARDING_STEP_INVALID: 409,
  APPLICANT_LIMIT_REACHED: 409,
  APPLICANT_READ_ONLY: 403,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/**
 * The only error type services throw. Anything else reaching the top-level
 * handler is a bug and becomes an opaque 500.
 *
 * Rules (docs/SECURITY.md):
 *  - `code` is the client contract. `message` is human text and may change.
 *  - Nothing internal ever reaches `message` — no SQL, no library text, no
 *    stack. Detail goes to the log with the request id instead.
 *  - Cross-user access uses notFound(), never a 403. A 403 confirms the row
 *    exists and turns ids into an enumeration oracle.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;
  readonly details?: Record<string, string[]>;

  constructor(code: ErrorCode, message: string, details?: Record<string, string[]>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        requestId,
      },
    };
  }

  // ---------------------------------------------------------------------
  // session / device — all terminal, all wipe the client session
  // ---------------------------------------------------------------------

  static unauthenticated(message = 'Sign in required.'): AppError {
    return new AppError(ErrorCode.UNAUTHENTICATED, message);
  }

  static deviceHeaderMissing(): AppError {
    return new AppError(ErrorCode.DEVICE_HEADER_MISSING, 'X-Device-Id header is required.');
  }

  static deviceUnknown(): AppError {
    return new AppError(
      ErrorCode.DEVICE_UNKNOWN, 'This device is not registered. Please sign in again.',
    );
  }

  static deviceEvicted(): AppError {
    return new AppError(
      ErrorCode.DEVICE_EVICTED, 'You were signed out because this account reached its device limit.',
    );
  }

  static deviceSignedOut(): AppError {
    return new AppError(
      ErrorCode.DEVICE_SIGNED_OUT, 'This device was signed out from another device.',
    );
  }

  static userDeleted(): AppError {
    return new AppError(ErrorCode.USER_DELETED, 'This account has been deleted.');
  }

  // ---------------------------------------------------------------------
  // generic
  // ---------------------------------------------------------------------

  static validation(details: Record<string, string[]>, message = 'Request validation failed.'): AppError {
    return new AppError(ErrorCode.VALIDATION_FAILED, message, details);
  }

  /** Also the answer for "exists but is not yours" — see the class comment. */
  static notFound(message = 'Not found.'): AppError {
    return new AppError(ErrorCode.NOT_FOUND, message);
  }

  static conflict(message: string): AppError {
    return new AppError(ErrorCode.CONFLICT, message);
  }

  static rateLimited(message = 'Too many requests. Please try again shortly.'): AppError {
    return new AppError(ErrorCode.RATE_LIMITED, message);
  }

  static internal(message = 'Something went wrong.'): AppError {
    return new AppError(ErrorCode.INTERNAL, message);
  }

  // ---------------------------------------------------------------------
  // domain
  // ---------------------------------------------------------------------

  /** PRD §6: the cap is CMS-driven, so it is echoed back rather than hardcoded in copy. */
  static applicantLimit(max: number): AppError {
    return new AppError(
      ErrorCode.APPLICANT_LIMIT_REACHED, `You can manage up to ${max} applicants on this account.`,
    );
  }

  /** PRD §7: grace_read_only and expired may read but not write. */
  static applicantReadOnly(message: string): AppError {
    return new AppError(ErrorCode.APPLICANT_READ_ONLY, message);
  }

  /** PRD §18: current legal version not accepted yet. */
  static legalRequired(
    message = 'Please accept the current terms before continuing.',
  ): AppError {
    return new AppError(ErrorCode.LEGAL_ACCEPTANCE_REQUIRED, message);
  }

  /** An onboarding step was skipped — the client is out of order, not invalid. */
  static onboardingStep(message: string): AppError {
    return new AppError(ErrorCode.ONBOARDING_STEP_INVALID, message);
  }
}

/** Narrowing helper for the top-level handler. */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
