import { loadEnv } from "@kash-commerce/config";
import { createPrisma } from "@kash-commerce/database";
import { createApp } from "./app";
import { createLogger } from "./lib/logger";
import { buildProviders } from "./providers";
import { syncRbac } from "./bootstrap";
import { startJobs } from "./jobs";

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    // meaningful startup error, no stack noise
    console.error((err as Error).message);
    process.exit(1);
  }
  const logger = createLogger(env.LOG_LEVEL);
  const prisma = createPrisma(env.DATABASE_URL);
  try {
    await prisma.$connect();
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      "Cannot connect to the database. Check DATABASE_URL and that Postgres is running and migrated.",
    );
    process.exit(1);
  }
  await syncRbac(prisma);
  const providers = buildProviders({ env, prisma, logger });
  const ctx = { env, prisma, logger, providers };
  const app = createApp(ctx);
  const server = app.listen(env.PORT, () =>
    logger.info({ port: env.PORT, env: env.NODE_ENV }, "commerce api listening"),
  );
  const stopJobs = startJobs(ctx);

  const shutdown = (sig: string) => {
    logger.info({ sig }, "shutting down");
    stopJobs();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main();
