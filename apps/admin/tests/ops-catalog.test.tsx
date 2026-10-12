import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ADMIN_PERMS, READ_ONLY_PERMS, callsTo, page, renderAt } from "./ops-helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const cat = (id: string, name: string, extra: object = {}) => ({
  id,
  name,
  slug: name.toLowerCase(),
  parentId: null,
  imageMediaId: null,
  bannerMediaId: null,
  description: null,
  sortOrder: 0,
  isActive: true,
  seo: null,
  productCount: 0,
  children: [],
  ...extra,
});
const tree = [
  cat("c1", "Men", { productCount: 3, children: [cat("c3", "Shirts", { parentId: "c1" })] }),
  cat("c2", "Women", { sortOrder: 1 }),
];

describe("categories", () => {
  it("renders the tree with indentation and creates a category", async () => {
    renderAt("/categories", ADMIN_PERMS, {
      "GET /categories": { body: { items: tree } },
      "POST /categories": { status: 201, body: cat("c9", "Kids") },
    });
    const u = userEvent.setup();
    expect(await screen.findByText("Shirts")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "New category" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.click(dlg.getByRole("button", { name: "Save category" }));
    expect(await dlg.findByText("Name is required")).toBeInTheDocument();
    await u.type(dlg.getByLabelText("Name"), "Kids");
    await u.selectOptions(dlg.getByLabelText("Parent category"), "Women");
    await u.click(dlg.getByRole("button", { name: "Save category" }));
    await waitFor(() => expect(callsTo("POST", "/categories")).toHaveLength(1));
    expect(callsTo("POST", "/categories")[0]!.body).toMatchObject({
      name: "Kids",
      parentId: "c2",
      sortOrder: 0,
      isActive: true,
      seo: null,
    });
  });

  it("excludes self and descendants from the parent select when editing", async () => {
    renderAt("/categories", ADMIN_PERMS, {
      "GET /categories": { body: { items: tree } },
      "PATCH /categories/c1": { body: tree[0] },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Edit Men" }));
    const dlg = within(await screen.findByRole("dialog"));
    const options = dlg.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("Women");
    expect(options).not.toContain("Men");
    expect(options).not.toContain("— Shirts");
    await u.click(dlg.getByRole("button", { name: "Save category" }));
    await waitFor(() => expect(callsTo("PATCH", "/categories/c1")).toHaveLength(1));
  });

  it("reorders siblings and deletes with a reassign target", async () => {
    renderAt("/categories", ADMIN_PERMS, {
      "GET /categories": { body: { items: tree } },
      "POST /categories/reorder": { body: { ok: true } },
      "DELETE /categories/c2": { status: 204 },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Move Women up" }));
    await waitFor(() => expect(callsTo("POST", "/categories/reorder")).toHaveLength(1));
    expect(callsTo("POST", "/categories/reorder")[0]!.body).toEqual({
      items: [
        { id: "c2", sortOrder: 0 },
        { id: "c1", sortOrder: 1 },
      ],
    });
    // category with products offers reassignment
    await u.click(screen.getByRole("button", { name: "Delete Women" }));
    let dlg = within(await screen.findByRole("dialog"));
    await u.click(dlg.getByRole("button", { name: "Delete category" }));
    await waitFor(() => expect(callsTo("DELETE", "/categories/c2")).toHaveLength(1));
    cleanup();
    renderAt("/categories", ADMIN_PERMS, {
      "GET /categories": { body: { items: tree } },
      "DELETE /categories/c1": { status: 204 },
    });
    await u.click(await screen.findByRole("button", { name: "Delete Men" }));
    dlg = within(await screen.findByRole("dialog"));
    expect(dlg.getByText(/has sub-categories/)).toBeInTheDocument();
    expect(dlg.getByRole("button", { name: "Delete category" })).toBeDisabled();
  });

  it("passes reassignTo when deleting a category that has products", async () => {
    const leaf = [cat("c1", "Men", { productCount: 3 }), cat("c2", "Women")];
    renderAt("/categories", ADMIN_PERMS, {
      "GET /categories": { body: { items: leaf } },
      "DELETE /categories/c1": { status: 204 },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Delete Men" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.selectOptions(dlg.getByLabelText(/3 product\(s\)/), "Women");
    await u.click(dlg.getByRole("button", { name: "Delete category" }));
    await waitFor(() => expect(callsTo("DELETE", "/categories/c1")).toHaveLength(1));
  });

  it("is read-only without categories.write", async () => {
    renderAt("/categories", READ_ONLY_PERMS, { "GET /categories": { body: { items: tree } } });
    expect(await screen.findByText("Men")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New category" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Men" })).not.toBeInTheDocument();
  });
});

describe("collections", () => {
  const manual = {
    id: "k1",
    name: "Summer",
    slug: "summer",
    type: "MANUAL",
    isActive: true,
    rules: null,
    description: null,
    imageMediaId: null,
    sortOrder: 0,
    manualProductCount: 1,
  };
  it("builds a rule collection payload", async () => {
    renderAt("/collections", ADMIN_PERMS, {
      "GET /categories": { body: { items: tree } },
      "GET /collections": { body: { items: [manual] } },
      "POST /collections": { status: 201, body: { ...manual, id: "k2" } },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "New collection" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.type(dlg.getByLabelText("Name"), "Cheap tees");
    await u.selectOptions(dlg.getByLabelText("Type"), "RULE");
    await u.selectOptions(dlg.getByLabelText("Field"), "Price");
    await u.click(dlg.getByRole("button", { name: "Save collection" }));
    expect(await dlg.findByText("Value is required")).toBeInTheDocument();
    await u.type(dlg.getByLabelText("Amount"), "25.00");
    await u.selectOptions(dlg.getByLabelText("Operator"), "lte");
    await u.click(dlg.getByRole("button", { name: "Add condition" }));
    await u.type(dlg.getAllByLabelText(/Value\(s\)/)[0]!, "linen, cotton");
    await u.click(dlg.getByRole("button", { name: "Save collection" }));
    await waitFor(() => expect(callsTo("POST", "/collections")).toHaveLength(1));
    expect(callsTo("POST", "/collections")[0]!.body).toMatchObject({
      name: "Cheap tees",
      type: "RULE",
      rules: {
        match: "all",
        conditions: [
          { field: "price", op: "lte", value: "25.00" },
          { field: "tag", value: ["linen", "cotton"] },
        ],
      },
    });
  });

  it("adds and removes manual members", async () => {
    renderAt("/collections", ADMIN_PERMS, {
      "GET /collections": { body: { items: [manual] } },
      "GET /collections/k1/products": {
        body: page([{ id: "p1", title: "Linen Shirt", slug: "ls", status: "ACTIVE", position: 0 }]),
      },
      "GET /products": {
        body: page([{ id: "p2", title: "Wool Hat", slug: "wh", status: "ACTIVE" }]),
      },
      "POST /collections/k1/products": { status: 201, body: { added: 1 } },
      "DELETE /collections/k1/products/p1": { status: 204 },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Products of Summer" }));
    const dlg = within(await screen.findByRole("dialog"));
    expect(await dlg.findByText("Linen Shirt")).toBeInTheDocument();
    await u.type(dlg.getByLabelText("Search products to add"), "wool");
    await u.click(await dlg.findByRole("button", { name: "Add Wool Hat" }));
    await waitFor(() => expect(callsTo("POST", "/collections/k1/products")).toHaveLength(1));
    expect(callsTo("POST", "/collections/k1/products")[0]!.body).toEqual({ productIds: ["p2"] });
    await u.click(dlg.getByRole("button", { name: "Remove Linen Shirt" }));
    await waitFor(() => expect(callsTo("DELETE", "/collections/k1/products/p1")).toHaveLength(1));
  });
});

describe("attributes", () => {
  const attr = {
    id: "a1",
    name: "Size",
    slug: "size",
    type: "TEXT",
    usedForVariants: true,
    isFilterable: true,
    sortOrder: 0,
    values: [{ id: "v1", attributeId: "a1", value: "Small", slug: "small", sortOrder: 0 }],
  };
  it("renames a value and surfaces the 409 when deleting a value in use", async () => {
    renderAt("/attributes", ADMIN_PERMS, {
      "GET /attributes": { body: { items: [attr] } },
      "PATCH /attribute-values/v1": { body: { ...attr.values[0], value: "Tiny" } },
      "DELETE /attribute-values/v1": {
        status: 409,
        body: { error: { code: "CONFLICT", message: "Value is used by products" } },
      },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Edit Size" }));
    const dlg = within(await screen.findByRole("dialog"));
    const input = dlg.getByLabelText("Value Small");
    await u.clear(input);
    await u.type(input, "Tiny");
    await u.click(dlg.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(callsTo("PATCH", "/attribute-values/v1")).toHaveLength(1));
    expect(callsTo("PATCH", "/attribute-values/v1")[0]!.body).toEqual({ value: "Tiny" });
    await u.click(dlg.getByRole("button", { name: "Delete value Small" }));
    const confirm = within(screen.getAllByRole("dialog")[1]!);
    await u.click(confirm.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Value is used by products")).toBeInTheDocument();
  });

  it("creates an attribute with initial values", async () => {
    renderAt("/attributes", ADMIN_PERMS, {
      "GET /attributes": { body: { items: [] } },
      "POST /attributes": { status: 201, body: { ...attr, id: "a2" } },
    });
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "New attribute" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.type(dlg.getByLabelText("Name"), "Colour");
    await u.type(dlg.getByLabelText("Initial values"), "Red, Blue");
    await u.click(dlg.getByRole("button", { name: "Create attribute" }));
    await waitFor(() => expect(callsTo("POST", "/attributes")).toHaveLength(1));
    expect(callsTo("POST", "/attributes")[0]!.body).toMatchObject({
      name: "Colour",
      type: "TEXT",
      usedForVariants: false,
      values: [{ value: "Red" }, { value: "Blue" }],
    });
  });
});

describe("inventory", () => {
  const item = {
    id: "i1",
    variantId: "var1",
    sku: "LS-S",
    variantTitle: null,
    productId: "p1",
    productTitle: "Linen Shirt",
    onHand: 4,
    reserved: 1,
    available: 3,
    lowStockThreshold: 5,
    trackInventory: true,
    allowBackorder: false,
    isLow: true,
  };
  it("requires a reason and sends a delta adjustment", async () => {
    renderAt("/inventory?low=1", ADMIN_PERMS, {
      "GET /inventory": { body: page([item]) },
      "PATCH /inventory/var1": { body: item },
      "GET /inventory/var1/movements": {
        body: page([
          {
            id: "m1",
            type: "ADJUSTMENT",
            quantity: 4,
            reason: "Initial stock",
            orderId: null,
            onHandAfter: 4,
            reservedAfter: 0,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ]),
      },
    });
    const u = userEvent.setup();
    await screen.findByText("Linen Shirt");
    expect(callsTo("GET", "/inventory")[0]!.query.get("lowStock")).toBe("true");
    await u.click(screen.getByRole("button", { name: "Adjust LS-S" }));
    const dlg = within(await screen.findByRole("dialog"));
    await u.type(dlg.getByLabelText(/Change by/), "-2");
    await u.click(dlg.getByRole("button", { name: "Save adjustment" }));
    expect(await dlg.findByText("A reason is required")).toBeInTheDocument();
    await u.type(dlg.getByLabelText("Reason"), "Damaged");
    await u.click(dlg.getByRole("button", { name: "Save adjustment" }));
    await waitFor(() => expect(callsTo("PATCH", "/inventory/var1")).toHaveLength(1));
    expect(callsTo("PATCH", "/inventory/var1")[0]!.body).toEqual({ reason: "Damaged", delta: -2 });
    await u.click(screen.getByRole("button", { name: "History LS-S" }));
    expect(await screen.findByText("Initial stock")).toBeInTheDocument();
  });

  it("hides Adjust without inventory.write", async () => {
    renderAt("/inventory", READ_ONLY_PERMS, { "GET /inventory": { body: page([item]) } });
    await screen.findByText("Linen Shirt");
    expect(screen.queryByRole("button", { name: "Adjust LS-S" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "History LS-S" })).toBeInTheDocument();
  });
});
