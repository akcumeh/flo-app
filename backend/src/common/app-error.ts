export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly title: string,
    public readonly detail?: string,
    public readonly headers: Record<string, string> = {}
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

  static conflict(code: string, detail: string) {
    return new AppError(409, code, 'Conflict', detail);
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
