import { DEFAULT_ROLES, PERMISSIONS } from "@kash-commerce/shared";
import type { PrismaClient } from "@kash-commerce/database";
import { hashPassword, passwordProblems } from "./lib/crypto";

/** Idempotently sync permissions + default roles (safe to run on every boot). */
export async function syncRbac(prisma: PrismaClient): Promise<void> {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
  const perms = await prisma.permission.findMany();
  const byKey = new Map(perms.map((p) => [p.key, p.id]));
  for (const [key, def] of Object.entries(DEFAULT_ROLES)) {
    const role = await prisma.role.upsert({
      where: { key },
      create: { key, name: def.name, description: def.description, isSystem: true },
      update: { isSystem: true },
    });
    // System roles: SUPER_ADMIN always gets everything; others only get *new* defaults added on first create.
    const existing = await prisma.rolePermission.count({ where: { roleId: role.id } });
    if (existing === 0 || key === "SUPER_ADMIN") {
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      await prisma.rolePermission.createMany({
        data: def.permissions.map((pk) => ({ roleId: role.id, permissionId: byKey.get(pk)! })),
      });
    }
  }
  await prisma.storeSettings.upsert({
    where: { id: "store" },
    create: { id: "store" },
    update: {},
  });
}

export async function createSuperAdmin(
  prisma: PrismaClient,
  input: { email: string; password: string; name?: string },
): Promise<{ created: boolean; id: string }> {
  const problems = passwordProblems(input.password);
  if (problems.length) throw new Error(`Admin password ${problems.join(", ")}`);
  await syncRbac(prisma);
  const email = input.email.toLowerCase();
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) return { created: false, id: existing.id };
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
  const user = await prisma.adminUser.create({
    data: {
      email,
      name: input.name ?? "Super Admin",
      passwordHash: await hashPassword(input.password),
      roleId: role.id,
    },
  });
  return { created: true, id: user.id };
}
