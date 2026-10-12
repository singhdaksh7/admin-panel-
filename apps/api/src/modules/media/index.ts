import crypto from "node:crypto";
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { imageSize } from "image-size";
import { z } from "zod";
import { Prisma, type Media } from "@kash-commerce/database";
import { AppError, clampPage, paginated } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { audit } from "../../lib/audit";
import { createLimiters } from "../../lib/rateLimits";
import { isValidStorageKey } from "../../providers/storage";
import { detectImageType, findMediaReferences, IMAGE_META, MIME_BY_EXT } from "./service";

export function presentMedia(ctx: AppContext, m: Media) {
  return {
    id: m.id,
    url: ctx.providers.storage.url(m.storageKey),
    filename: m.filename,
    mimeType: m.mimeType,
    sizeBytes: m.sizeBytes,
    width: m.width,
    height: m.height,
    altText: m.altText,
    createdAt: m.createdAt,
  };
}

const patchBody = z.object({ altText: z.string().trim().max(300).nullable() });

function displayName(original: string): string {
  // eslint-disable-next-line no-control-regex
  const base = path.basename(original.replace(/\\/g, "/")).replace(/[\u0000-\u001f<>"|?*]/g, "");
  return base.slice(0, 150) || "upload";
}

export function register(ctx: AppContext): ModuleRoutes {
  const p = ctx.prisma;
  const limiters = createLimiters(ctx.env.NODE_ENV !== "test");
  const maxBytes = Math.floor(ctx.env.MAX_UPLOAD_MB * 1024 * 1024);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5, parts: 8 },
  }).single("file");

  const uploadMw = (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE")
          return next(
            new AppError(413, "BAD_REQUEST", `File too large (max ${ctx.env.MAX_UPLOAD_MB} MB)`),
          );
        return next(AppError.badRequest(`Upload error: ${err.code}`));
      }
      next(err);
    });
  };

  // ───── public: local file serving ─────
  const pub = Router();
  pub.get(
    "/media/files/:key",
    limiters.publicRead,
    h(async (req, res) => {
      const key = String(req.params.key);
      const storage = ctx.providers.storage;
      if (!isValidStorageKey(key) || !storage.read) throw AppError.notFound("File");
      const data = await storage.read(key);
      if (!data) throw AppError.notFound("File");
      const ext = key.split(".").pop()!;
      res.setHeader("Content-Type", MIME_BY_EXT[ext] ?? "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Content-Length", String(data.length));
      res.end(data);
    }),
  );

  // ───── admin ─────
  const admin = Router();

  admin.get(
    "/media",
    requirePermission("media.read"),
    h(async (req, res) => {
      const pg = clampPage(req.query.page, req.query.pageSize);
      const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
      const where: Prisma.MediaWhereInput = q
        ? {
            OR: [
              { filename: { contains: q, mode: "insensitive" } },
              { altText: { contains: q, mode: "insensitive" } },
            ],
          }
        : {};
      const [items, total] = await Promise.all([
        p.media.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (pg.page - 1) * pg.pageSize,
          take: pg.pageSize,
        }),
        p.media.count({ where }),
      ]);
      res.json(
        paginated(
          items.map((m) => presentMedia(ctx, m)),
          total,
          pg,
        ),
      );
    }),
  );

  admin.get(
    "/media/:id",
    requirePermission("media.read"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const m = await p.media.findUnique({ where: { id } });
      if (!m) throw AppError.notFound("Media");
      res.json({ ...presentMedia(ctx, m), references: await findMediaReferences(p, id) });
    }),
  );

  admin.post(
    "/media",
    requirePermission("media.write"),
    uploadMw,
    h(async (req, res) => {
      const file = req.file;
      if (!file)
        throw AppError.badRequest('No file uploaded (multipart field name must be "file")');
      const buf = file.buffer;
      const type = detectImageType(buf);
      if (!type)
        throw AppError.validation(
          "Unsupported or invalid image (allowed: jpeg, png, webp, gif, avif)",
        );
      const meta = IMAGE_META[type];
      const name = displayName(file.originalname);
      const ext = path.extname(name).slice(1).toLowerCase();
      if (!ext || !meta.extensions.includes(ext))
        throw AppError.validation("File extension does not match the file content");
      if (
        file.mimetype &&
        file.mimetype !== "application/octet-stream" &&
        file.mimetype !== meta.mime
      )
        throw AppError.validation("Declared content type does not match the file content");

      let width: number | null = null;
      let height: number | null = null;
      try {
        const dim = imageSize(buf);
        width = dim.width ?? null;
        height = dim.height ?? null;
      } catch {
        if (type !== "avif") throw AppError.validation("Corrupt image");
      }
      if (type !== "avif" && (!width || !height)) throw AppError.validation("Corrupt image");

      const storageKey = `${crypto.randomBytes(16).toString("hex")}.${meta.ext}`;
      await ctx.providers.storage.put(storageKey, buf, meta.mime);
      let created: Media;
      try {
        created = await p.media.create({
          data: {
            storageKey,
            provider: ctx.providers.storage.key,
            filename: name,
            mimeType: meta.mime,
            sizeBytes: buf.length,
            width,
            height,
            checksum: crypto.createHash("sha256").update(buf).digest("hex"),
            altText:
              typeof req.body?.altText === "string" ? req.body.altText.trim().slice(0, 300) : null,
          },
        });
      } catch (err) {
        await ctx.providers.storage.delete(storageKey).catch(() => undefined);
        throw err;
      }
      await audit(ctx, req, {
        action: "media.upload",
        entityType: "Media",
        entityId: created.id,
        after: { filename: name, mimeType: meta.mime, sizeBytes: buf.length },
      });
      res.status(201).json(presentMedia(ctx, created));
    }),
  );

  admin.patch(
    "/media/:id",
    requirePermission("media.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(patchBody, req.body);
      const existing = await p.media.findUnique({ where: { id } });
      if (!existing) throw AppError.notFound("Media");
      const m = await p.media.update({ where: { id }, data: { altText: body.altText || null } });
      await audit(ctx, req, {
        action: "media.update",
        entityType: "Media",
        entityId: id,
        before: { altText: existing.altText },
        after: { altText: m.altText },
      });
      res.json(presentMedia(ctx, m));
    }),
  );

  admin.delete(
    "/media/:id",
    requirePermission("media.write"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const m = await p.media.findUnique({ where: { id } });
      if (!m) throw AppError.notFound("Media");
      const refs = await findMediaReferences(p, id);
      if (refs.length) throw AppError.conflict("Media is in use and cannot be deleted", refs);
      try {
        await p.media.delete({ where: { id } });
      } catch (err) {
        // FK restrict from a concurrent reference
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003")
          throw AppError.conflict("Media is in use and cannot be deleted");
        throw err;
      }
      await ctx.providers.storage.delete(m.storageKey).catch((err) => {
        ctx.logger.warn({ err, key: m.storageKey }, "failed to delete stored file");
      });
      await audit(ctx, req, {
        action: "media.delete",
        entityType: "Media",
        entityId: id,
        before: { filename: m.filename },
      });
      res.status(204).end();
    }),
  );

  return { public: pub, admin };
}
