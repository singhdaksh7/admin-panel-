import request from "supertest";
import type { Express } from "express";
import { loadEnv } from "@kash-commerce/config";
import { createPrisma } from "@kash-commerce/database";
import { createApp } from "../src/app";
import { createLogger } from "../src/lib/logger";
import { buildProviders } from "../src/providers";
import { createSuperAdmin, syncRbac } from "../src/bootstrap";
import { hashPassword } from "../src/lib/crypto";
import type { AppContext } from "../src/context";

export const ADMIN_EMAIL = "root@test.example";
export const ADMIN_PASSWORD = "Sup3r-secret-pass";

const prisma = createPrisma(process.env.DATABASE_URL);

export function makeContext(overrides: Partial<Record<string, string>> = {}): AppContext {
  const env = loadEnv({ ...process.env, ...overrides });
  const logger = createLogger("silent", true);
  const ctx = { env, prisma, logger, providers: buildProviders({ env, prisma, logger }) };
  return ctx;
}

export async function resetDb() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\_prisma%'`;
  const names = rows.map((r) => `"${r.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
  await syncRbac(prisma);
}

export interface AdminSessionHandle {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  /** helpers that add the CSRF header on unsafe methods */
  get: (url: string) => request.Test;
  post: (url: string, body?: object) => request.Test;
  put: (url: string, body?: object) => request.Test;
  patch: (url: string, body?: object) => request.Test;
  del: (url: string) => request.Test;
}

export async function loginAdmin(
  app: Express,
  email = ADMIN_EMAIL,
  password = ADMIN_PASSWORD,
): Promise<AdminSessionHandle> {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/admin/auth/login").send({ email, password });
  if (res.status !== 200)
    throw new Error(`admin login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const h: AdminSessionHandle = {
    agent,
    csrf: res.body.csrfToken,
    get: (u) => agent.get(u),
    post: (u, b) =>
      agent
        .post(u)
        .set("x-csrf-token", h.csrf)
        .send(b ?? {}),
    put: (u, b) =>
      agent
        .put(u)
        .set("x-csrf-token", h.csrf)
        .send(b ?? {}),
    patch: (u, b) =>
      agent
        .patch(u)
        .set("x-csrf-token", h.csrf)
        .send(b ?? {}),
    del: (u) => agent.delete(u).set("x-csrf-token", h.csrf),
  };
  return h;
}

/** Fresh DB + super admin + app. */
export async function bootApp() {
  await resetDb();
  await createSuperAdmin(prisma, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const ctx = makeContext();
  const app = createApp(ctx);
  return { app, ctx, prisma, admin: () => loginAdmin(app) };
}

export async function createAdminWithRole(
  roleKey: string,
  email: string,
  password = "Another-Pass-123",
) {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.adminUser.create({
    data: { email, name: roleKey, passwordHash: await hashPassword(password), roleId: role.id },
  });
}

export { prisma, request };
