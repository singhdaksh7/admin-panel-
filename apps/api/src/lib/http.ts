import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { AppError } from "@kash-commerce/shared";

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wrap async route handlers so rejections reach the error middleware. */
export function h(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw AppError.validation(
      "Invalid request",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

export const idParam = z.object({ id: z.string().min(1).max(64) });

export function clientIp(req: Request): string | undefined {
  return req.ip ?? undefined;
}
