import crypto from "node:crypto";
import argon2 from "argon2";

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** Opaque random token (url-safe). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Password policy: 10+ chars, not trivially weak. */
export function passwordProblems(pw: string): string[] {
  const p: string[] = [];
  if (pw.length < 10) p.push("must be at least 10 characters");
  if (pw.length > 200) p.push("is too long");
  if (!/[a-z]/.test(pw) || !/[A-Z0-9\W]/.test(pw))
    p.push("must mix lowercase with upper-case, digits or symbols");
  return p;
}
