import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { calls, lastCall, mockFetch, paginated, renderApp } from "./growth-helpers";
import { cleanContent, validateContent } from "../src/features/pages/sections";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PERMS = ["content.read", "content.write", "media.read", "categories.read", "products.read"];
const page = {
  id: "p1",
  slug: "home",
  title: "Home",
  status: "PUBLISHED",
  publishAt: null,
  seo: null,
  updatedAt: "2026-01-01T00:00:00Z",
  sections: [
    {
      id: "s1",
      type: "TEXT",
      key: null,
      content: { body: "Hello <b>world</b>", align: "left" },
      sortOrder: 0,
      isEnabled: true,
      startsAt: null,
      endsAt: null,
    },
    {
      id: "s2",
      type: "PROMO_BANNER",
      key: null,
      content: { text: "Free shipping" },
      sortOrder: 1,
      isEnabled: true,
      startsAt: null,
      endsAt: null,
    },
  ],
};

type R = { status?: number; body?: unknown } | undefined;
function api(extra?: (path: string, method: string) => R) {
  return (_u: string, init: RequestInit, path: string) => {
    const method = init.method ?? "GET";
    const custom = extra?.(path, method);
    if (custom) return custom;
    if (path === "/pages/p1" && method === "GET") return { body: page };
    if (path.startsWith("/content/section-types"))
      return {
        body: {
          types: [
            "HERO",
            "PROMO_BANNER",
            "TEXT",
            "IMAGE",
            "PRODUCT_GRID",
            "CATEGORY_GRID",
            "RICH_TEXT",
            "REVIEWS",
            "BLOG_PREVIEW",
            "CUSTOM_JSON",
          ],
        },
      };
    if (path.startsWith("/categories") || path.startsWith("/collections"))
      return { body: { items: [] } };
    if (path === "/pages/p1/sections" && method === "POST")
      return { status: 201, body: { id: "s3" } };
    if (path === "/pages/p1/sections/reorder" && method === "PUT") return { body: [] };
    if (path.startsWith("/pages?"))
      return { body: paginated([{ ...page, _count: { sections: 2 } }]) };
    return undefined;
  };
}

describe("pages: section editor", () => {
  it("adds a HERO section with the exact payload shape", async () => {
    mockFetch(api(), PERMS);
    renderApp("/pages/p1");
    const u = userEvent.setup();
    await screen.findByText("Sections (2)");
    await u.selectOptions(screen.getByLabelText("Section type"), "HERO");
    await u.click(screen.getByRole("button", { name: "Add section" }));
    const dialog = await screen.findByRole("dialog");
    await u.type(within(dialog).getByLabelText("Heading"), "Summer sale");
    await u.type(within(dialog).getByLabelText("Primary button label"), "Shop");
    await u.type(within(dialog).getByLabelText("Primary button URL"), "/shop");
    await u.click(within(dialog).getByRole("button", { name: "Add section" }));
    await waitFor(() => expect(lastCall("POST", "/pages/p1/sections")).toBeTruthy());
    expect(lastCall("POST", "/pages/p1/sections")!.body).toEqual({
      type: "HERO",
      content: { heading: "Summer sale", align: "left", cta: { label: "Shop", url: "/shop" } },
      isEnabled: true,
    });
  });

  it("blocks empty required fields client-side and shows server errors by path", async () => {
    let reject = false;
    mockFetch(
      api((path, method) =>
        reject && path === "/pages/p1/sections" && method === "POST"
          ? {
              status: 422,
              body: {
                error: {
                  code: "VALIDATION_ERROR",
                  message: "Invalid content for section type HERO",
                  details: [
                    {
                      path: "content.cta.url",
                      message: "must be a relative path (/...), http(s) URL, mailto: or tel:",
                    },
                  ],
                },
              },
            }
          : undefined,
      ),
      PERMS,
    );
    renderApp("/pages/p1");
    const u = userEvent.setup();
    await screen.findByText("Sections (2)");
    await u.selectOptions(screen.getByLabelText("Section type"), "HERO");
    await u.click(screen.getByRole("button", { name: "Add section" }));
    const dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: "Add section" }));
    expect(await within(dialog).findAllByText("Heading is required")).not.toHaveLength(0);
    expect(lastCall("POST", "/pages/p1/sections")).toBeUndefined();

    reject = true;
    await u.type(within(dialog).getByLabelText("Heading"), "Hi");
    await u.type(within(dialog).getByLabelText("Primary button label"), "Go");
    await u.type(within(dialog).getByLabelText("Primary button URL"), "javascript:x");
    await u.click(within(dialog).getByRole("button", { name: "Add section" }));
    const alert = await within(dialog).findByRole("alert", { name: "Validation errors" });
    expect(alert).toHaveTextContent("content.cta.url");
    expect(alert).toHaveTextContent("must be a relative path");
  });

  it("reorders sections via PUT /sections/reorder with every id", async () => {
    mockFetch(api(), PERMS);
    renderApp("/pages/p1");
    const u = userEvent.setup();
    await screen.findByText("Sections (2)");
    await u.click(screen.getByRole("button", { name: "Move Text section down" }));
    await waitFor(() => expect(lastCall("PUT", "/pages/p1/sections/reorder")).toBeTruthy());
    expect(lastCall("PUT", "/pages/p1/sections/reorder")!.body).toEqual({ ids: ["s2", "s1"] });
  });

  it("hides write controls without content.write", async () => {
    mockFetch(api(), ["content.read"]);
    renderApp("/pages/p1");
    await screen.findByText("Sections (2)");
    expect(screen.queryByRole("button", { name: "Add section" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
});

describe("section helpers", () => {
  it("cleanContent drops empties but keeps false and 0", () => {
    expect(cleanContent({ a: "", b: { c: "" }, d: false, e: 0, f: [], g: "x" })).toEqual({
      d: false,
      e: 0,
      g: "x",
    });
  });
  it("validates CUSTOM_JSON and IMAGE requirements", () => {
    expect(validateContent("CUSTOM_JSON", {}, "{bad").content).toBe("Invalid JSON");
    expect(validateContent("CUSTOM_JSON", {}, '{"a":1}')).toEqual({});
    expect(validateContent("IMAGE", {})["content.image.desktopMediaId"]).toBeTruthy();
  });
});
