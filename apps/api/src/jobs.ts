import type { AppContext } from "./context";

/** Periodic housekeeping. Modules may push tasks onto `tasks` (kept in one place for visibility). */
export const tasks: Array<{
  name: string;
  everyMs: number;
  run: (ctx: AppContext) => Promise<void>;
}> = [
  {
    name: "purge-expired",
    everyMs: 60 * 60 * 1000,
    run: async (ctx) => {
      const now = new Date();
      await ctx.prisma.adminSession.deleteMany({ where: { expiresAt: { lt: now } } });
      await ctx.prisma.customerSession.deleteMany({ where: { expiresAt: { lt: now } } });
      await ctx.prisma.cart.deleteMany({ where: { expiresAt: { lt: now } } });
      await ctx.prisma.idempotencyKey.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - 48 * 3600_000) } },
      });
    },
  },
];

export function startJobs(ctx: AppContext): () => void {
  const timers = tasks.map((t) =>
    setInterval(() => {
      t.run(ctx).catch((err) => ctx.logger.error({ err, job: t.name }, "job failed"));
    }, t.everyMs).unref(),
  );
  return () => timers.forEach(clearInterval);
}
