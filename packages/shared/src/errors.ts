export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "OUT_OF_STOCK"
  | "PAYMENT_FAILED"
  | "PROVIDER_ERROR"
  | "CSRF_FAILED"
  | "ACCOUNT_LOCKED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
  static badRequest(msg: string, details?: unknown) {
    return new AppError(400, "BAD_REQUEST", msg, details);
  }
  static validation(msg: string, details?: unknown) {
    return new AppError(422, "VALIDATION_ERROR", msg, details);
  }
  static unauthenticated(msg = "Authentication required") {
    return new AppError(401, "UNAUTHENTICATED", msg);
  }
  static forbidden(msg = "You do not have permission") {
    return new AppError(403, "FORBIDDEN", msg);
  }
  static notFound(what = "Resource") {
    return new AppError(404, "NOT_FOUND", `${what} not found`);
  }
  static conflict(msg: string, details?: unknown) {
    return new AppError(409, "CONFLICT", msg, details);
  }
  static outOfStock(msg: string, details?: unknown) {
    return new AppError(409, "OUT_OF_STOCK", msg, details);
  }
}

/** Shape returned by every API error. Mirrored by the Storefront SDK. */
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown; requestId?: string };
}
