import type { Express } from "express";
import { prisma, request } from "./helpers";

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface SeedOpts {
  title?: string;
  price?: string;
  stock?: number;
  taxRate?: string;
  hsn?: string;
  categoryId?: string | null;
  status?: "DRAFT" | "ACTIVE" | "ARCHIVED";
  trackInventory?: boolean;
  allowBackorder?: boolean;
  variantActive?: boolean;
}

/** Creates Product + default Variant + InventoryItem straight through prisma (no catalog API yet). */
export async function seedProduct(o: SeedOpts = {}) {
  const id = uid();
  let taxClassId: string | undefined;
  if (o.taxRate) {
    const tc = await prisma.taxClass.upsert({
      where: { name: `T${o.taxRate}` },
      create: { name: `T${o.taxRate}`, rate: o.taxRate, hsnCode: o.hsn ?? null },
      update: { hsnCode: o.hsn ?? null },
    });
    taxClassId = tc.id;
  }
  const product = await prisma.product.create({
    data: {
      title: o.title ?? `Product ${id}`,
      slug: `p-${id}`,
      status: o.status ?? "ACTIVE",
      categoryId: o.categoryId ?? null,
      taxClassId,
      variants: {
        create: {
          sku: `SKU-${id}`,
          price: o.price ?? "10.00",
          isDefault: true,
          isActive: o.variantActive ?? true,
          inventory: {
            create: {
              onHand: o.stock ?? 10,
              trackInventory: o.trackInventory ?? true,
              allowBackorder: o.allowBackorder ?? false,
            },
          },
        },
      },
    },
    include: { variants: true },
  });
  return { product, variant: product.variants[0]! };
}

export async function seedCategory(name: string, parentId?: string) {
  return prisma.category.create({ data: { name, slug: `${name.toLowerCase()}-${uid()}`, parentId } });
}

export const addr = (over: Record<string, unknown> = {}) => ({
  fullName: "Asha Rao",
  phone: "9999999999",
  line1: "12 MG Road",
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560001",
  country: "IN",
  ...over,
});

export const PW = "Passw0rd-long!";

export interface CustomerHandle {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  id: string;
  email: string;
  post: (u: string, b?: object) => request.Test;
  patch: (u: string, b?: object) => request.Test;
  del: (u: string) => request.Test;
  get: (u: string) => request.Test;
}

function handle(agent: ReturnType<typeof request.agent>, csrf: string, id: string, email: string): CustomerHandle {
  return {
    agent,
    csrf,
    id,
    email,
    get: (u) => agent.get(u),
    post: (u, b) => agent.post(u).set("x-csrf-token", csrf).send(b ?? {}),
    patch: (u, b) => agent.patch(u).set("x-csrf-token", csrf).send(b ?? {}),
    del: (u) => agent.delete(u).set("x-csrf-token", csrf),
  };
}

export async function registerCustomer(app: Express, email: string, password = PW) {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/account/register").send({ email, password, firstName: "Test" });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  return handle(agent, res.body.csrfToken, res.body.customer.id, email);
}

export async function loginCustomer(app: Express, email: string, password = PW) {
  const agent = request.agent(app);
  const res = await agent.post("/api/v1/account/login").send({ email, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  return handle(agent, res.body.csrfToken, res.body.customer.id, email);
}

/** Add to an anonymous cart; returns its token. */
export async function addToCart(app: Express, variantId: string, quantity = 1, token?: string) {
  const r = request(app).post("/api/v1/cart/items");
  if (token) r.set("x-cart-token", token);
  const res = await r.send({ variantId, quantity });
  if (res.status !== 201) throw new Error(`addToCart ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

export async function checkout(
  app: Express,
  token: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return request(app)
    .post("/api/v1/checkout/create")
    .set(headers)
    .send({ cartToken: token, email: "buyer@example.com", shippingAddress: addr(), ...body });
}

export async function stockOf(variantId: string) {
  return prisma.inventoryItem.findUniqueOrThrow({ where: { variantId } });
}
