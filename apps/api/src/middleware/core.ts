import crypto from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError, type ApiErrorBody } from "@kash-commerce/shared";
import type { Logger } from "pino";

declare module "express-serve-static-core" {
  interface Request {
    id: string;
    admin?: AdminPrincipal;
    customer?: CustomerPrincipal;
    rawBody?: Buffer;
  }
}

export interface AdminPrincipal {
  id: string;
  email: string;
  name: string;
  roleKey: string;
  permissions: Set<string>;
  sessionId: string;
  csrfToken: string;
}
export interface CustomerPrincipal {
  id: string;
  email: string;
  sessionId: string;
  csrfToken: string;
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header("x-request-id");
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
};

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => next(AppError.notFound("Route"));
}

export function errorHandler(logger: Logger, isProd: boolean): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let status = 500;
    let body: ApiErrorBody["error"] = {
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
      requestId: req.id,
    };
    if (err instanceof AppError) {
      status = err.status;
      body = { code: err.code, message: err.message, details: err.details, requestId: req.id };
    } else if (err instanceof ZodError) {
      status = 422;
      body = {
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        requestId: req.id,
      };
    } else if (err?.type === "entity.too.large") {
      status = 413;
      body = { code: "BAD_REQUEST", message: "Request body too large", requestId: req.id };
    } else if (err?.type === "entity.parse.failed") {
      status = 400;
      body = { code: "BAD_REQUEST", message: "Malformed JSON", requestId: req.id };
    } else if (err?.name === "MulterError") {
      status = 400;
      body = { code: "BAD_REQUEST", message: `Upload rejected: ${err.code}`, requestId: req.id };
    } else {
      logger.error({ err, requestId: req.id, path: req.path }, "unhandled error");
      if (!isProd) body.message = String(err?.message ?? body.message);
    }
    if (status >= 500 && !(err instanceof AppError)) {
      // already logged above
    } else if (status >= 500) {
      logger.error({ err, requestId: req.id }, "app error 5xx");
    }
    res.status(status).json({ error: body });
  };
}
