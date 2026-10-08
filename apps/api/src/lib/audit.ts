import type { Request } from "express";
import type { Prisma } from "@kash-commerce/database";
import type { AppContext } from "../context";

const SENSITIVE = /pass(word)?|secret|token|authorization|cookie|card|cvv|api[-_]?key|hash/i;

/** Recursively strip sensitive keys and truncate long strings before logging. */
export function scrub(value: unknown, depth = 0): unknown {
  if (value == null || depth > 4) return value ?? null;
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    if (
      typeof (value as { toFixed?: unknown }).toFixed === "function" ||
      "toNumber" in (value as object)
    )
      return String(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface AuditInput {
  action: string; // "product.update"
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  extra?: unknown;
}

/** Record a sensitive admin mutation. Never throws into the request path. */
export async function audit(ctx: AppContext, req: Request, input: AuditInput): Promise<void> {
  try {
    await ctx.prisma.auditLog.create({
      data: {
        actorId: req.admin?.id ?? null,
        actorEmail: req.admin?.email ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: scrub({
          before: input.before,
          after: input.after,
          extra: input.extra,
        }) as Prisma.InputJsonValue,
        requestId: req.id,
        ip: req.ip ?? null,
      },
    });
  } catch (err) {
    ctx.logger.error({ err }, "failed to write audit log");
  }
}
