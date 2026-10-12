import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lastCall, mockFetch, renderApp, type Handler } from "./growth-helpers";
import {
  MAX_DEPTH,
  addChild,
  blankNode,
  indentNode,
  moveNode,
  outdentNode,
  toApi,
  treeDepth,
  validateTree,
} from "../src/features/navigation/tree";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const navApi: Handler = (_u, init, path) => {
  const method = init.method ?? "GET";
  if (path === "/navigation" && method === "GET")
    return { body: { items: [{ id: "m1", key: "header", name: "Header", itemCount: 0 }] } };
  if (path === "/navigation/header" && method === "GET")
    return { body: { id: "m1", key: "header", name: "Header", items: [] } };
  if (path === "/navigation/header" && method === "PUT")
    return { body: { id: "m1", key: "header", name: "Header", items: [] } };
  if (path.startsWith("/categories"))
    return { body: { items: [{ id: "c1", name: "Mens", slug: "mens", parentId: null }] } };
  if (path.startsWith("/collections")) return { body: { items: [] } };
  if (path.startsWith("/pages"))
    return { body: { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 } };
  return undefined;
};
const PERMS = ["content.read", "navigation.write", "categories.read", "products.read"];

describe("navigation builder", () => {
  it("builds a nested tree and saves the expected payload", async () => {
    mockFetch(navApi, PERMS);
    renderApp("/navigation");
    const u = userEvent.setup();
    await screen.findByText("This menu is empty");

    await u.click(screen.getByRole("button", { name: "Add item" }));
    const label = await screen.findByLabelText("Label");
    await u.clear(label);
    await u.type(label, "Shop");
    await u.type(screen.getByLabelText("URL"), "/shop");

    await u.click(screen.getByRole("button", { name: "Add child to Shop" }));
    const childLabel = await screen.findByLabelText("Label");
    await u.clear(childLabel);
    await u.type(childLabel, "Men");
    await u.selectOptions(screen.getByLabelText("Type"), "CATEGORY");
    await u.selectOptions(await screen.findByLabelText("Category"), "c1");
    await u.click(screen.getByLabelText("Automatically list its subcategories"));
    await u.type(screen.getByLabelText("Badge"), "New");

    await u.click(screen.getByRole("button", { name: "Save menu" }));
    await waitFor(() => expect(lastCall("PUT", "/navigation/header")).toBeTruthy());
    expect(lastCall("PUT", "/navigation/header")!.body).toEqual({
      name: "Header",
      items: [
        {
          label: "Shop",
          type: "LINK",
          url: "/shop",
          showDesktop: true,
          showMobile: true,
          openInNewTab: false,
          active: true,
          children: [
            {
              label: "Men",
              type: "CATEGORY",
              categoryId: "c1",
              autoChildren: true,
              badge: "New",
              showDesktop: true,
              showMobile: true,
              openInNewTab: false,
              active: true,
            },
          ],
        },
      ],
    });
  });

  it("refuses to save an incomplete item", async () => {
    mockFetch(navApi, PERMS);
    renderApp("/navigation");
    const u = userEvent.setup();
    await screen.findByText("This menu is empty");
    await u.click(screen.getByRole("button", { name: "Add item" }));
    await u.click(screen.getByRole("button", { name: "Save menu" }));
    expect(await screen.findByText(/URL is required/)).toBeInTheDocument();
    expect(lastCall("PUT", "/navigation/header")).toBeUndefined();
  });

  it("is read-only without navigation.write", async () => {
    mockFetch(navApi, ["content.read"]);
    renderApp("/navigation");
    await screen.findByText("This menu is empty");
    expect(screen.queryByRole("button", { name: "Add item" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save menu" })).not.toBeInTheDocument();
  });
});

describe("tree helpers", () => {
  const n = (label: string) => blankNode({ label, type: "LINK", url: "/x" });

  it("indents under the previous sibling, outdents back, and moves", () => {
    let t = [n("a"), n("b"), n("c")];
    t = indentNode(t, t[1]!.uid)!;
    expect(t.map((x) => x.label)).toEqual(["a", "c"]);
    expect(t[0]!.children.map((x) => x.label)).toEqual(["b"]);
    t = outdentNode(t, t[0]!.children[0]!.uid)!;
    expect(t.map((x) => x.label)).toEqual(["a", "b", "c"]);
    t = moveNode(t, t[2]!.uid, -1);
    expect(t.map((x) => x.label)).toEqual(["a", "c", "b"]);
    expect(indentNode(t, t[0]!.uid)).toBeNull(); // first item cannot be indented
    expect(outdentNode(t, t[0]!.uid)).toBeNull(); // root item cannot be outdented
  });

  it(`enforces max depth of ${MAX_DEPTH}`, () => {
    let t = [n("l1")];
    let parent = t[0]!.uid;
    for (let i = 2; i <= MAX_DEPTH; i++) {
      const c = n(`l${i}`);
      t = addChild(t, parent, c);
      parent = c.uid;
    }
    expect(treeDepth(t)).toBe(MAX_DEPTH);
    // a sibling subtree at level 1 cannot be indented below the deepest level
    t = [...t, n("extra")];
    t = [{ ...t[0]! }, { ...t[1]!, children: [n("kid")] }];
    t = indentNode(t, t[1]!.uid) ?? t;
    expect(validateTree(addChild(t, parent, n("too-deep")))._tree).toMatch(/at most 4/);
  });

  it("serialises ids, promo and omits empty optionals", () => {
    const mega = blankNode({
      id: "nav_1",
      label: "Mega",
      type: "MEGA",
      promo: { title: "Sale", subtitle: "", mediaId: "m9", url: "/sale", ctaLabel: "" },
    });
    expect(toApi([mega])).toEqual([
      {
        id: "nav_1",
        label: "Mega",
        type: "MEGA",
        promo: { title: "Sale", url: "/sale", mediaId: "m9" },
        showDesktop: true,
        showMobile: true,
        openInNewTab: false,
        active: true,
      },
    ]);
  });
});
