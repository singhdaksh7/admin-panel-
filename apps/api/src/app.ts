import express, { Router, type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import type { AppContext } from "./context";
import { errorHandler, notFoundHandler, requestId } from "./middleware/core";
import { adminAuth } from "./middleware/adminAuth";
import { createLimiters } from "./lib/rateLimits";
import { modules } from "./modules/registry";
import { h } from "./lib/http";

export const API_PREFIX = "/api/v1";

export function createApp(ctx: AppContext): Express {
  const app = express();
  const isProd = ctx.env.NODE_ENV === "production";
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");

  app.disable("x-powered-by");
  app.set("trust proxy", isProd ? 1 : false);
  app.use(requestId);
  app.use(
    pinoHttp({
      logger: ctx.logger,
      genReqId: (req) => (req as express.Request).id,
      customProps: (req) => ({ requestId: (req as express.Request).id }),
      autoLogging: { ignore: (req) => req.url?.startsWith("/api/health") ?? false },
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

  const allowed = new Set(ctx.env.CORS_ORIGINS);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-CSRF-Token", "X-Request-Id", "Idempotency-Key"],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
  );

  // Webhooks need the raw body for signature verification; capture it on every JSON parse.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(cookieParser());

  // Health (outside versioned API, no rate limit, no auth)
  app.get("/api/health", (_req, res) =>
    res.json({ status: "ok", uptime: Math.round(process.uptime()) }),
  );
  app.get(
    "/api/ready",
    h(async (_req, res) => {
      try {
        await ctx.prisma.$queryRaw`SELECT 1`;
        res.json({ status: "ready", database: "ok" });
      } catch {
        res.status(503).json({ status: "not_ready", database: "unreachable" });
      }
    }),
  );

  const publicRouter = Router();
  const adminPublicRouter = Router();
  const adminRouter = Router();
  const webhookRouter = Router();
  for (const register of modules) {
    const r = register(ctx);
    if (r.public) publicRouter.use(r.public);
    if (r.adminPublic) adminPublicRouter.use(r.adminPublic);
    if (r.admin) adminRouter.use(r.admin);
    if (r.webhooks) webhookRouter.use(r.webhooks);
  }

  app.use(`${API_PREFIX}/webhooks`, limiters.webhook, webhookRouter);
  app.use(`${API_PREFIX}/admin/auth`, adminPublicRouter);
  app.use(`${API_PREFIX}/admin`, limiters.adminApi, adminAuth(ctx), adminRouter);
  app.use(API_PREFIX, publicRouter);

  app.use(notFoundHandler());
  app.use(errorHandler(ctx.logger, isProd));
  return app;
}
