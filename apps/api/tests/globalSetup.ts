import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@kash-commerce/database";

const here = path.dirname(fileURLToPath(import.meta.url));

export function testDatabaseUrl(): string {
  const base =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://commerce:commerce_dev_only@localhost:55440/commerce?schema=public";
  const u = new URL(base);
  u.pathname = `/${process.env.TEST_DB_NAME ?? "commerce_test"}`;
  return u.toString();
}

/** Creates the test DB if needed and applies ALL migrations from scratch-equivalent state. */
export default async function setup() {
  const testUrl = testDatabaseUrl();
  const admin = new URL(testUrl);
  admin.pathname = "/postgres";
  const client = new PrismaClient({ datasourceUrl: admin.toString() });
  try {
    const name = (process.env.TEST_DB_NAME ?? "commerce_test").replace(/[^a-z0-9_]/gi, "");
    await client.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } catch {
    /* already exists */
  } finally {
    await client.$disconnect();
  }
  execSync("npx prisma migrate deploy --schema packages/database/prisma/schema.prisma", {
    cwd: path.resolve(here, "../../.."),
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: "pipe",
  });
  process.env.TEST_DATABASE_URL = testUrl;
}
