import { ERROR_STATUS, type ErrorCode } from '@agent-edit/shared';

export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = ERROR_STATUS[code];
  }
}
