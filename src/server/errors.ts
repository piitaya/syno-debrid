import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ErrorCode, ErrorInfo } from '../shared/types.js';

/** An error with a stable code that the web app can translate. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }

  toInfo(): ErrorInfo {
    return this.message && this.message !== this.code
      ? { code: this.code, message: this.message }
      : { code: this.code };
  }
}

/** An AppError that maps to an HTTP status when thrown from a route. */
export class HttpError extends AppError {
  constructor(
    readonly status: ContentfulStatusCode,
    code: ErrorCode,
    message?: string,
  ) {
    super(code, message);
    this.name = 'HttpError';
  }
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof AppError) return error.toInfo();
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) };
}
