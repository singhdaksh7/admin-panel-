import type { ErrorCode } from "./types";

export interface CommerceErrorInit {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
  /** parsed Retry-After header in ms, when the server sent one */
  retryAfterMs?: number;
  cause?: unknown;
}

/** Every failure of the SDK (HTTP, network, timeout) is a `CommerceError`. */
export class CommerceError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(init: CommerceErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "CommerceError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** Safe to retry automatically (only meaningful for idempotent requests). */
  get isRetryable(): boolean {
    return (
      this.code === "NETWORK_ERROR" ||
      this.code === "TIMEOUT" ||
      this.status === 429 ||
      this.status === 502 ||
      this.status === 503 ||
      this.status === 504 ||
      (this.status >= 500 && this.code === "INTERNAL_ERROR")
    );
  }

  isNotFound(): boolean {
    return this.status === 404 || this.code === "NOT_FOUND";
  }
  isValidation(): boolean {
    return this.code === "VALIDATION_ERROR" || this.status === 422;
  }
  isOutOfStock(): boolean {
    return this.code === "OUT_OF_STOCK";
  }
  isUnauthenticated(): boolean {
    return this.status === 401 || this.code === "UNAUTHENTICATED";
  }
  isRateLimited(): boolean {
    return this.status === 429 || this.code === "RATE_LIMITED";
  }
  isNetworkError(): boolean {
    return this.code === "NETWORK_ERROR" || this.code === "TIMEOUT";
  }

  /** Field-level problems of a 422, as `{ path, message }[]` (empty when none). */
  fieldErrors(): Array<{ path: string; message: string }> {
    return Array.isArray(this.details)
      ? (this.details as unknown[]).filter(
          (d): d is { path: string; message: string } =>
            !!d &&
            typeof d === "object" &&
            typeof (d as { message?: unknown }).message === "string",
        )
      : [];
  }

  toJSON() {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      message: this.message,
      details: this.details,
      requestId: this.requestId,
    };
  }
}

export function isCommerceError(e: unknown): e is CommerceError {
  return e instanceof CommerceError;
}

/** Map a bare HTTP status (non-JSON error body) onto the API's error codes. */
export function codeForStatus(status: number): ErrorCode {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 422) return "VALIDATION_ERROR";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "INTERNAL_ERROR";
  return "BAD_REQUEST";
}
