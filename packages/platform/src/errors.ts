import { ERROR_STATUS, ERROR_TITLES, type ErrorCode, type FieldError } from '@astra/contracts';

/** A failure that maps directly to an API problem response. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;

  constructor(code: ErrorCode, detail?: string, errors?: FieldError[]) {
    super(detail ?? ERROR_TITLES[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.detail = detail;
    this.errors = errors;
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} was not found.`);
export const forbidden = (detail?: string) => new AppError('forbidden', detail);
export const conflict = (detail: string) => new AppError('conflict', detail);
export const preconditionFailed = (detail: string) => new AppError('precondition_failed', detail);
