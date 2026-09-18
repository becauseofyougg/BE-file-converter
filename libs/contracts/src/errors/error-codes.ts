/**
 * Stable error codes. The client branches on these, never on the message text,
 * which is why they are a versioned contract and not free-form strings.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // auth / registration — see docs/REGISTRATION.md §8
  PASSWORD_TOO_WEAK: 'PASSWORD_TOO_WEAK',
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  CONFIRMATION_INVALID: 'CONFIRMATION_INVALID',
  CONFIRMATION_EXPIRED: 'CONFIRMATION_EXPIRED',
  CONFIRMATION_ATTEMPTS_EXCEEDED: 'CONFIRMATION_ATTEMPTS_EXCEEDED',
  RESEND_TOO_SOON: 'RESEND_TOO_SOON',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REUSED: 'TOKEN_REUSED',
  FORBIDDEN: 'FORBIDDEN',

  // conversion
  UNSUPPORTED_CONVERSION: 'UNSUPPORTED_CONVERSION',
  INVALID_SOURCE: 'INVALID_SOURCE',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  CONVERSION_TIMEOUT: 'CONVERSION_TIMEOUT',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  RESULT_EXPIRED: 'RESULT_EXPIRED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * The single response envelope of the public API.
 */
export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: unknown;
  correlationId: string;
}

/**
 * Retryable failures go back on the queue with backoff; permanent ones are
 * terminal immediately. Getting this classification wrong either burns three
 * attempts on a corrupt file or drops a job on a transient storage blip.
 */
export const PERMANENT_ERROR_CODES: readonly string[] = [
  ERROR_CODES.UNSUPPORTED_CONVERSION,
  ERROR_CODES.INVALID_SOURCE,
  ERROR_CODES.FILE_TOO_LARGE,
];
