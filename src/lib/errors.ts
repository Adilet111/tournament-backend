/**
 * Stable machine-readable error codes. The `error` message is for humans and
 * may change; clients (and their translations) should branch on `code`.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  500: 'internal_error',
  501: 'not_implemented',
};

export function codeForStatus(statusCode: number): string {
  return CODE_BY_STATUS[statusCode] ?? 'error';
}

export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 400, code?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code ?? codeForStatus(statusCode);
  }
}
