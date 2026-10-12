/**
 * create-store: interactive (or flag-driven) setup for a new client deployment.
 *
 *   npm run create-store                          # interactive
 *   npm run create-store -- --yes --name "Acme" --currency USD ...   # non-interactive (see --help)
 *   npm run create-store -- --apply store.config.json                # push settings into the DB
 *
 * Writes: <out>/.env (secrets generated, provider secrets blank) and <out>/store.config.json.
 * Refuses to overwrite existing files without --force. NEVER writes an admin password.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  PAYMENT_PROVIDERS,
  SHIPPING_PROVIDERS,
  buildEnv,
  buildStoreConfig,
  nextSteps,
  slugify,
  validateAnswers,
  type StoreAnswers,
} from "./generate";
import { applyStoreConfig } from "./apply";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

const HELP = `create-store options:
  --name <text>  --slug <slug>  --currency <ISO>  --locale <bcp47>  --timezone <IANA>
  --payment <MANUAL|RAZORPAY|MOCK>  --shipping <MANUAL|SHIPROCKET|MOCK>
  --tax <NONE|EXCLUSIVE|INCLUSIVE|INDIA_GST>  --admin-email <email>
  --no-accounts --no-reviews --no-blog --no-coupons --no-inventory
  --out <dir> (default .)  --force  --yes (non-interactive)  --apply <store.config.json>`;

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.help) return console.log(HELP);

  if (typeof f.apply === "string") {
    const file = path.resolve(f.apply);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const url = process.env.DATABASE_URL;
    if (!url)
      throw new Error("DATABASE_URL must be set (source your .env) to apply the store config");
    await applyStoreConfig(url, cfg);
    console.log(`Applied settings from ${file}`);
    return;
  }

  const interactive = !f.yes && process.stdin.isTTY;
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const ask = async (q: string, def: string): Promise<string> => {
    if (!rl) return def;
    const v = (await rl.question(`${q} [${def}]: `)).trim();
    return v || def;
  };
  const askBool = async (q: string, def: boolean, flagOff: string) => {
    if (f[flagOff]) return false;
    const v = (await ask(`${q} (y/n)`, def ? "y" : "n")).toLowerCase();
    return v.startsWith("y");
  };
  const askChoice = async <T extends string>(
    q: string,
    options: readonly T[],
    def: T,
    given?: string | boolean,
  ) => {
    if (typeof given === "string") return given.toUpperCase() as T;
    const v = (await ask(`${q} (${options.join("/")})`, def)).toUpperCase();
    return (options.includes(v as T) ? v : def) as T;
  };

  const storeName = typeof f.name === "string" ? f.name : await ask("Store name", "My Store");
  const storeSlug =
    typeof f.slug === "string" ? f.slug : await ask("Store slug", slugify(storeName));
  const currency = (
    typeof f.currency === "string" ? f.currency : await ask("Currency (ISO 4217)", "USD")
  ).toUpperCase();
  const locale =
    typeof f.locale === "string"
      ? f.locale
      : await ask("Locale", currency === "INR" ? "en-IN" : "en-US");
  const timezone =
    typeof f.timezone === "string"
      ? f.timezone
      : await ask("Timezone (IANA)", currency === "INR" ? "Asia/Kolkata" : "UTC");
  const paymentProvider = await askChoice(
    "Payment provider",
    PAYMENT_PROVIDERS,
    "MANUAL",
    f.payment,
  );
  const shippingProvider = await askChoice(
    "Shipping provider",
    SHIPPING_PROVIDERS,
    "MANUAL",
    f.shipping,
  );
  const taxMode = await askChoice(
    "Tax mode",
    ["NONE", "EXCLUSIVE", "INCLUSIVE", "INDIA_GST"] as const,
    currency === "INR" ? "INDIA_GST" : "NONE",
    f.tax,
  );
  const answers: StoreAnswers = {
    storeName,
    storeSlug,
    currency,
    locale,
    timezone,
    paymentProvider,
    shippingProvider,
    taxMode,
    customerAccounts: await askBool("Enable customer accounts?", true, "no-accounts"),
    reviews: await askBool("Enable reviews?", true, "no-reviews"),
    blog: await askBool("Enable blog?", true, "no-blog"),
    coupons: await askBool("Enable coupons?", true, "no-coupons"),
    inventory: await askBool("Enable inventory tracking?", true, "no-inventory"),
    adminEmail:
      typeof f["admin-email"] === "string"
        ? f["admin-email"]
        : await ask("Initial admin email", "admin@example.com"),
  };
  rl?.close();

  const err = validateAnswers(answers);
  if (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }

  const out = path.resolve(typeof f.out === "string" ? f.out : ".");
  fs.mkdirSync(out, { recursive: true });
  const envPath = path.join(out, ".env");
  const cfgPath = path.join(out, "store.config.json");
  for (const p of [envPath, cfgPath]) {
    if (fs.existsSync(p) && !f.force) {
      console.error(`Refusing to overwrite ${p} (use --force).`);
      process.exit(1);
    }
  }
  fs.writeFileSync(envPath, buildEnv(answers), { mode: 0o600 });
  fs.writeFileSync(cfgPath, JSON.stringify(buildStoreConfig(answers), null, 2) + "\n");
  console.log(`\nWrote ${envPath} (mode 600) and ${cfgPath}\n`);
  console.log(nextSteps(answers, envPath));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
