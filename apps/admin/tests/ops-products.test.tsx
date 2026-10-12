import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADMIN_PERMS, READ_ONLY_PERMS, callsTo, page, renderAt } from "./ops-helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const sizeAttr = {
  id: "a-size",
  name: "Size",
  slug: "size",
  type: "TEXT",
  usedForVariants: true,
  isFilterable: true,
  sortOrder: 0,
  values: [
    { id: "v-s", attributeId: "a-size", value: "Small", slug: "small", sortOrder: 0 },
    { id: "v-m", attributeId: "a-size", value: "Medium", slug: "medium", sortOrder: 1 },
  ],
};
const refs = {
  "GET /categories": {
    body: {
      items: [
        { id: "c1", name: "Shirts", slug: "shirts", parentId: null, productCount: 0, children: [] },
      ],
    },
  },
  "GET /attributes": { body: { items: [sizeAttr] } },
  "GET /collections": { body: { items: [] } },
  "GET /tax-classes": { body: { items: [] } },
};

const product = {
  id: "p1",
  title: "Linen Shirt",
  slug: "linen-shirt",
  shortDescription: null,
  description: null,
  status: "ACTIVE",
  visibility: "live",
  categoryId: "c1",
  taxClassId: null,
  brand: null,
  isFeatured: false,
  isNew: false,
  publishAt: null,
  unpublishAt: null,
  seo: null,
  images: [],
  attributeValues: [],
  tags: [],
  collections: [],
  variants: [
    {
      id: "var1",
      productId: "p1",
      sku: "LS-S",
      barcode: null,
      title: null,
      price: "40.00",
      compareAtPrice: null,
      cost: null,
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      imageMediaId: null,
      isDefault: true,
      isActive: true,
      position: 0,
      attributes: [{ attributeId: "a-size", attribute: "Size", valueId: "v-s", value: "Small" }],
      inventory: {
        onHand: 4,
        reserved: 0,
        available: 4,
        lowStockThreshold: 5,
        trackInventory: true,
        allowBackorder: false,
      },
    },
  ],
};

describe("products", () => {
  it("lists products and offers write actions only with products.write", async () => {
    const listBody = page([
      {
        id: "p1",
        title: "Linen Shirt",
        slug: "linen-shirt",
        status: "ACTIVE",
        visibility: "live",
        brand: null,
        isFeatured: false,
        category: null,
        image: null,
        variantCount: 2,
        priceMin: "10.00",
        priceMax: "20.00",
        totalAvailable: 3,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    renderAt("/products?status=ACTIVE", ADMIN_PERMS, {
      ...refs,
      "GET /products": { body: listBody },
    });
    expect(await screen.findByText("Linen Shirt")).toBeInTheDocument();
    expect(screen.getByText("$10.00 – $20.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New product" })).toBeInTheDocument();
    expect(callsTo("GET", "/products")[0]!.query.get("status")).toBe("ACTIVE");
    cleanup();

    renderAt("/products", READ_ONLY_PERMS, { ...refs, "GET /products": { body: listBody } });
    expect(await screen.findByText("Linen Shirt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New product" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Select Linen Shirt")).not.toBeInTheDocument();
  });

  it("creates a simple product with the expected payload", async () => {
    renderAt("/products/new", ADMIN_PERMS, {
      ...refs,
      "POST /products": { status: 201, body: product },
      "GET /products/p1": { body: product },
      "GET /products": { body: page([]) },
    });
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Title"), "My Widget");
    expect(screen.getByLabelText("Slug")).toHaveValue("my-widget");
    await u.type(screen.getByLabelText("Price"), "12.50");
    await u.type(screen.getByLabelText("Stock quantity"), "7");
    await u.type(screen.getByLabelText(/^Tags/), "sale, summer,");
    await u.click(screen.getByRole("button", { name: "Create product" }));
    await waitFor(() => expect(callsTo("POST", "/products")).toHaveLength(1));
    expect(callsTo("POST", "/products")[0]!.body).toMatchObject({
      title: "My Widget",
      slug: "my-widget",
      status: "DRAFT",
      price: "12.50",
      compareAtPrice: null,
      cost: null,
      stock: 7,
      trackInventory: true,
      categoryId: null,
      imageMediaIds: [],
      attributeValueIds: [],
      tags: ["sale", "summer"],
      collectionIds: [],
      seo: null,
      publishAt: null,
    });
    expect(callsTo("POST", "/products")[0]!.body).not.toHaveProperty("variants");
  });

  it("validates required fields client-side and does not call the API", async () => {
    renderAt("/products/new", ADMIN_PERMS, refs);
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Create product" }));
    expect(await screen.findByText("Title is required")).toBeInTheDocument();
    expect(screen.getByText("Enter a price like 12.50")).toBeInTheDocument();
    await u.type(screen.getByLabelText("Title"), "X");
    await u.type(screen.getByLabelText("Price"), "10");
    await u.type(screen.getByLabelText("Compare-at price"), "5");
    await u.click(screen.getByRole("button", { name: "Create product" }));
    expect(await screen.findByText("Must be at least the price")).toBeInTheDocument();
    expect(callsTo("POST", "/products")).toHaveLength(0);
  });

  it("maps API validation errors onto fields", async () => {
    renderAt("/products/new", ADMIN_PERMS, {
      ...refs,
      "POST /products": {
        status: 409,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid",
            details: [{ path: "sku", message: "SKU already in use" }],
          },
        },
      },
    });
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Title"), "Thing");
    await u.type(screen.getByLabelText("Price"), "3");
    await u.click(screen.getByRole("button", { name: "Create product" }));
    expect(await screen.findAllByText("SKU already in use")).not.toHaveLength(0);
  });

  it("hides write controls for read-only admins on the edit page", async () => {
    renderAt("/products/p1", READ_ONLY_PERMS, { ...refs, "GET /products/p1": { body: product } });
    expect(await screen.findByRole("heading", { name: "Linen Shirt" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Duplicate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add variant" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeDisabled();
  });

  it("adds a variant with an attribute combination", async () => {
    renderAt("/products/p1", ADMIN_PERMS, {
      ...refs,
      "GET /products/p1": { body: product },
      "POST /products/p1/variants": { status: 201, body: { ...product.variants[0], id: "var2" } },
    });
    const u = userEvent.setup();
    expect(await screen.findByText(/at least one attribute value/)).toBeInTheDocument();
    await u.click(await screen.findByRole("button", { name: "Add variant" }));
    const dlg = within(await screen.findByRole("dialog"));
    // validation first
    await u.click(dlg.getByRole("button", { name: "Save variant" }));
    expect(await dlg.findByText("SKU is required")).toBeInTheDocument();
    await u.selectOptions(dlg.getByLabelText("Size"), "Medium");
    await u.type(dlg.getByLabelText("SKU"), "LS-M");
    await u.type(dlg.getByLabelText("Price"), "42");
    await u.type(dlg.getByLabelText("Initial stock"), "5");
    await u.click(dlg.getByRole("button", { name: "Save variant" }));
    await waitFor(() => expect(callsTo("POST", "/products/p1/variants")).toHaveLength(1));
    expect(callsTo("POST", "/products/p1/variants")[0]!.body).toMatchObject({
      sku: "LS-M",
      price: "42",
      attributeValueIds: ["v-m"],
      stock: 5,
      isActive: true,
    });
  });

  it("requires attribute values for every variant when creating a multi-variant product", async () => {
    renderAt("/products/new", ADMIN_PERMS, {
      ...refs,
      "POST /products": { status: 201, body: product },
    });
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Title"), "Tee");
    await u.click(screen.getByLabelText("This product has multiple variants"));
    for (const [sku, size] of [
      ["T-1", ""],
      ["T-2", "Small"],
    ] as const) {
      await u.click(screen.getByRole("button", { name: "Add variant" }));
      const dlg = within(await screen.findByRole("dialog"));
      if (size) await u.selectOptions(dlg.getByLabelText("Size"), size);
      await u.type(dlg.getByLabelText("SKU"), sku);
      await u.type(dlg.getByLabelText("Price"), "9.99");
      await u.click(dlg.getByRole("button", { name: "Save variant" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
    await u.click(screen.getByRole("button", { name: "Create product" }));
    expect(await screen.findByText(/needs an attribute value/)).toBeInTheDocument();
    expect(callsTo("POST", "/products")).toHaveLength(0);
  });
});
