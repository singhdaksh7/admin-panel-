/**
 * Creates the initial SUPER_ADMIN. Credentials come from the environment (never committed):
 *   INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD   (or interactive prompt if password missing & TTY)
 */
import readline from "node:readline/promises";
import { createPrisma } from "@kash-commerce/database";
import { createSuperAdmin } from "../../apps/api/src/bootstrap";

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  let email = process.env.INITIAL_ADMIN_EMAIL;
  let password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email && process.stdin.isTTY) email = await prompt("Admin email: ");
  if (!password && process.stdin.isTTY) password = await prompt("Admin password (min 10 chars): ");
  if (!email || !password) {
    throw new Error("Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD (or run interactively).");
  }
  const prisma = createPrisma(url);
  try {
    const r = await createSuperAdmin(prisma, { email, password });
    console.log(
      r.created ? `Created SUPER_ADMIN ${email}` : `Admin ${email} already exists - left unchanged`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
