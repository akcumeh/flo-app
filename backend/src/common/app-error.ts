export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly title: string,
    public readonly detail?: string,
    public readonly headers: Record<string, string> = {},
    public readonly extra: Record<string, unknown> = {}
  ) {
    super(detail ?? title);
  }

  static unauthorized(code = 'unauthorized', detail = 'Sign in to continue.') {
    return new AppError(401, code, 'Unauthorized', detail);
  }

  static badRequest(code: string, detail: string) {
    return new AppError(400, code, 'Bad request', detail);
  }

  static notFound(detail = 'No such resource.') {
    return new AppError(404, 'not_found', 'Not found', detail);
  }

  static conflict(code: string, detail: string, extra: Record<string, unknown> = {}) {
    return new AppError(409, code, 'Conflict', detail, {}, extra);
  }

  static gone(code: string, detail: string) {
    return new AppError(410, code, 'Gone', detail);
  }

  static unprocessable(code: string, detail: string) {
    return new AppError(422, code, 'Unprocessable', detail);
  }

  static unavailable(code: string, detail: string) {
    return new AppError(503, code, 'Unavailable', detail);
  }

  static rateLimited(retryAfterSeconds: number) {
    return new AppError(429, 'rate_limited', 'Too many requests', `Try again in ${retryAfterSeconds} seconds.`, {
      'Retry-After': String(retryAfterSeconds),
    });
  }

  static insufficientTokens(needed: number, balance: number) {
    return new AppError(
      402,
      'insufficient_tokens',
      'Not enough tokens',
      `This needs ${needed} token${needed === 1 ? '' : 's'} and the balance is ${balance}.`
    );
  }

  static notImplemented() {
    return new AppError(501, 'not_implemented', 'Not implemented', 'This endpoint is in the spec but not built yet.');
  }
}
