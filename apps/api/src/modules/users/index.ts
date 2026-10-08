import { Router } from "express";
import { z } from "zod";
import { AppError, clampPage, paginated, PERMISSIONS } from "@kash-commerce/shared";
import type { AppContext } from "../../context";
import type { ModuleRoutes } from "../types";
import { h, idParam, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/adminAuth";
import { hashPassword, passwordProblems } from "../../lib/crypto";
import { audit } from "../../lib/audit";

const createUser = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(120),
  password: z.string().min(1).max(200),
  roleId: z.string().min(1),
  mustChangePassword: z.boolean().optional(),
});
const updateUser = z.object({
  name: z.string().min(1).max(120).optional(),
  roleId: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});
const roleBody = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  permissions: z.array(z.enum(PERMISSIONS)),
});

const userSelect = {
  id: true,
  email: true,
  name: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  roleId: true,
  role: { select: { id: true, key: true, name: true } },
} as const;

export function register(ctx: AppContext): ModuleRoutes {
  const r = Router();
  const p = ctx.prisma;

  r.get(
    "/users",
    requirePermission("users.read"),
    h(async (req, res) => {
      const pg = clampPage(req.query.page, req.query.pageSize);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const where = q
        ? {
            OR: [
              { email: { contains: q, mode: "insensitive" as const } },
              { name: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {};
      const [items, total] = await Promise.all([
        p.adminUser.findMany({
          where,
          select: userSelect,
          orderBy: { createdAt: "desc" },
          skip: (pg.page - 1) * pg.pageSize,
          take: pg.pageSize,
        }),
        p.adminUser.count({ where }),
      ]);
      res.json(paginated(items, total, pg));
    }),
  );

  r.post(
    "/users",
    requirePermission("users.manage"),
    h(async (req, res) => {
      const body = parse(createUser, req.body);
      const problems = passwordProblems(body.password);
      if (problems.length) throw AppError.validation(`Password ${problems.join(", ")}`);
      const role = await p.role.findUnique({ where: { id: body.roleId } });
      if (!role) throw AppError.validation("Unknown role");
      if (role.key === "SUPER_ADMIN" && req.admin!.roleKey !== "SUPER_ADMIN")
        throw AppError.forbidden("Only a Super Admin can create Super Admins");
      const email = body.email.toLowerCase();
      if (await p.adminUser.findUnique({ where: { email } }))
        throw AppError.conflict("Email already in use");
      const user = await p.adminUser.create({
        data: {
          email,
          name: body.name,
          roleId: body.roleId,
          passwordHash: await hashPassword(body.password),
          mustChangePassword: body.mustChangePassword ?? true,
        },
        select: userSelect,
      });
      await audit(ctx, req, {
        action: "user.create",
        entityType: "AdminUser",
        entityId: user.id,
        after: { email, role: role.key },
      });
      res.status(201).json(user);
    }),
  );

  r.patch(
    "/users/:id",
    requirePermission("users.manage"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(updateUser, req.body);
      const existing = await p.adminUser.findUnique({ where: { id }, include: { role: true } });
      if (!existing) throw AppError.notFound("User");
      if (existing.role.key === "SUPER_ADMIN" && req.admin!.roleKey !== "SUPER_ADMIN")
        throw AppError.forbidden("Only a Super Admin can modify Super Admins");
      if (body.roleId) {
        const role = await p.role.findUnique({ where: { id: body.roleId } });
        if (!role) throw AppError.validation("Unknown role");
        if (role.key === "SUPER_ADMIN" && req.admin!.roleKey !== "SUPER_ADMIN")
          throw AppError.forbidden("Only a Super Admin can grant Super Admin");
      }
      // never leave the store without an active super admin
      const demoting =
        (body.isActive === false || (body.roleId && body.roleId !== existing.roleId)) &&
        existing.role.key === "SUPER_ADMIN";
      if (demoting) {
        const others = await p.adminUser.count({
          where: { id: { not: id }, isActive: true, role: { key: "SUPER_ADMIN" } },
        });
        if (others === 0) throw AppError.conflict("Cannot remove the last active Super Admin");
      }
      if (id === req.admin!.id && body.isActive === false)
        throw AppError.conflict("You cannot deactivate yourself");
      const user = await p.adminUser.update({ where: { id }, data: body, select: userSelect });
      if (body.isActive === false || body.roleId) {
        await p.adminSession.updateMany({
          where: { adminUserId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await audit(ctx, req, {
        action: "user.update",
        entityType: "AdminUser",
        entityId: id,
        before: { roleId: existing.roleId, isActive: existing.isActive },
        after: body,
      });
      res.json(user);
    }),
  );

  r.get(
    "/roles",
    requirePermission("users.read"),
    h(async (_req, res) => {
      const roles = await p.role.findMany({
        include: {
          permissions: { include: { permission: true } },
          _count: { select: { admins: true } },
        },
        orderBy: { name: "asc" },
      });
      res.json({
        items: roles.map((x) => ({
          id: x.id,
          key: x.key,
          name: x.name,
          description: x.description,
          isSystem: x.isSystem,
          userCount: x._count.admins,
          permissions: x.permissions.map((rp) => rp.permission.key).sort(),
        })),
        allPermissions: PERMISSIONS,
      });
    }),
  );

  async function setPermissions(roleId: string, keys: string[]) {
    const perms = await p.permission.findMany({ where: { key: { in: keys } } });
    await p.rolePermission.deleteMany({ where: { roleId } });
    await p.rolePermission.createMany({ data: perms.map((x) => ({ roleId, permissionId: x.id })) });
  }

  r.post(
    "/roles",
    requirePermission("roles.manage"),
    h(async (req, res) => {
      const body = parse(roleBody, req.body);
      const key = body.name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      if (!key) throw AppError.validation("Invalid role name");
      if (await p.role.findUnique({ where: { key } }))
        throw AppError.conflict("Role already exists");
      const role = await p.role.create({
        data: { key, name: body.name, description: body.description },
      });
      await setPermissions(role.id, body.permissions);
      await audit(ctx, req, {
        action: "role.create",
        entityType: "Role",
        entityId: role.id,
        after: body,
      });
      res.status(201).json({ id: role.id, key });
    }),
  );

  r.put(
    "/roles/:id",
    requirePermission("roles.manage"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const body = parse(roleBody, req.body);
      const role = await p.role.findUnique({ where: { id } });
      if (!role) throw AppError.notFound("Role");
      if (role.key === "SUPER_ADMIN") throw AppError.conflict("SUPER_ADMIN permissions are fixed");
      await p.role.update({
        where: { id },
        data: { name: body.name, description: body.description },
      });
      await setPermissions(id, body.permissions);
      await p.adminSession.updateMany({
        where: { adminUser: { roleId: id }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await audit(ctx, req, {
        action: "role.update",
        entityType: "Role",
        entityId: id,
        after: body,
      });
      res.json({ ok: true });
    }),
  );

  r.delete(
    "/roles/:id",
    requirePermission("roles.manage"),
    h(async (req, res) => {
      const { id } = parse(idParam, req.params);
      const role = await p.role.findUnique({
        where: { id },
        include: { _count: { select: { admins: true } } },
      });
      if (!role) throw AppError.notFound("Role");
      if (role.isSystem) throw AppError.conflict("System roles cannot be deleted");
      if (role._count.admins > 0) throw AppError.conflict("Role is assigned to users");
      await p.role.delete({ where: { id } });
      await audit(ctx, req, { action: "role.delete", entityType: "Role", entityId: id });
      res.json({ ok: true });
    }),
  );

  r.get(
    "/audit-logs",
    requirePermission("audit.read"),
    h(async (req, res) => {
      const pg = clampPage(req.query.page, req.query.pageSize, 50);
      const where: Record<string, unknown> = {};
      if (typeof req.query.action === "string") where.action = { contains: req.query.action };
      if (typeof req.query.entityType === "string") where.entityType = req.query.entityType;
      if (typeof req.query.actorId === "string") where.actorId = req.query.actorId;
      const [items, total] = await Promise.all([
        p.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (pg.page - 1) * pg.pageSize,
          take: pg.pageSize,
        }),
        p.auditLog.count({ where }),
      ]);
      res.json(paginated(items, total, pg));
    }),
  );

  return { admin: r };
}
