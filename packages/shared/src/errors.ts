export const ERROR_STATUS = {
  validation_failed: 400,
  unauthenticated: 401,
  invalid_credentials: 401,
  forbidden: 403,
  not_found: 404,
  email_taken: 409,
  upload_incomplete: 409,
  conflict: 409,
  file_too_large: 413,
  unsupported_media: 415,
  rate_limited: 429,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}
