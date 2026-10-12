import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { calls, lastCall, mockFetch, renderApp, type Handler } from "./growth-helpers";
import { buildPayload, toState } from "../src/features/settings/model";
import { toBulkPayload, blankGroup, validateGroups } from "../src/features/filters/Filters";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("filters configuration", () => {
  const filtersApi: Handler = (_u, init, path) => {
    const method = init.method ?? "GET";
    if (path.startsWith("/filters/effective/")) return { body: { items: [] } };
    if (path.startsWith("/filters?")) return { body: { items: [] } };
    if (path.startsWith("/filters/scope/") && method === "PUT") return { body: { items: [] } };
    if (path.startsWith("/categories"))
      return { body: { items: [{ id: "c1", name: "Mens", slug: "mens", parentId: null }] } };
    if (path.startsWith("/attributes"))
      return { body: { items: [{ id: "a1", name: "Color", slug: "color" }] } };
    return undefined;
  };

  it("builds the bulk payload for the global scope", async () => {
    mockFetch(filtersApi, ["filters.write"]);
    renderApp("/filters");
    const u = userEvent.setup();
    await screen.findByText("No filters defined here");

    await u.click(screen.getByRole("button", { name: "Add filter group" }));
    let dialog = await screen.findByRole("dialog");
    await u.selectOptions(within(dialog).getByLabelText("Source"), "ATTRIBUTE");
    await u.selectOptions(await within(dialog).findByLabelText("Attribute"), "a1");
    expect(within(dialog).getByLabelText("Label")).toHaveValue("Color");
    await u.click(within(dialog).getByRole("button", { name: "Add" }));

    await u.click(screen.getByRole("button", { name: "Add filter group" }));
    dialog = await screen.findByRole("dialog");
    await u.selectOptions(within(dialog).getByLabelText("Source"), "PRICE");
    await u.click(within(dialog).getByLabelText("Show on mobile"));
    await u.click(within(dialog).getByRole("button", { name: "Add" }));

    // reorder: move Price above Color
    await u.click(screen.getByRole("button", { name: "Move Price up" }));
    await u.click(screen.getByRole("button", { name: "Save filters" }));
    await waitFor(() => expect(lastCall("PUT", "/filters/scope/global")).toBeTruthy());
    const base = {
      isEnabled: true,
      defaultOpen: true,
      showDesktop: true,
      inheritToChildren: true,
    };
    expect(lastCall("PUT", "/filters/scope/global")!.body).toEqual({
      groups: [
        { source: "PRICE", label: "Price", multiSelect: false, showMobile: false, ...base },
        {
          source: "ATTRIBUTE",
          attributeId: "a1",
          label: "Color",
          multiSelect: true,
          showMobile: true,
          ...base,
        },
      ],
    });
  });

  it("loads a category scope and its effective view", async () => {
    mockFetch(filtersApi, ["filters.write"]);
    renderApp("/filters");
    const u = userEvent.setup();
    await screen.findByText("No filters defined here");
    await u.selectOptions(screen.getByLabelText("Scope"), "c1");
    await waitFor(() => expect(calls.some((c) => c.path === "/filters/effective/c1")).toBe(true));
    expect(calls.some((c) => c.path.startsWith("/filters?categoryId=c1"))).toBe(true);
  });

  it("pure helpers: payload ordering and duplicate detection", () => {
    const a = blankGroup({ source: "PRICE", label: "Price" });
    const b = blankGroup({ source: "PRICE", label: "Price 2" });
    expect(validateGroups([a, b]).join()).toMatch(/already configured/);
    expect(validateGroups([blankGroup({ source: "ATTRIBUTE", label: "x" })]).join()).toMatch(
      /choose an attribute/,
    );
    expect(toBulkPayload([a]).groups[0]).not.toHaveProperty("attributeId");
  });
});

describe("store settings", () => {
  const row = {
    name: "Aadhya",
    legalName: null,
    logoMediaId: null,
    faviconMediaId: null,
    supportEmail: "s@x.test",
    phone: null,
    address: { city: "Pune" },
    currency: "INR",
    locale: "en-IN",
    timezone: "Asia/Kolkata",
    tax: { mode: "INDIA_GST", defaultRate: 18 },
    checkout: { guestCheckout: true },
    features: { blog: true },
    social: {},
  };
  const settingsApi =
    (put?: (body: unknown) => { status?: number; body?: unknown }): Handler =>
    (_u, init, path) => {
      const method = init.method ?? "GET";
      if (path === "/settings" && method === "GET") return { body: row };
      if (path === "/settings" && method === "PUT")
        return put ? put(JSON.parse(init.body as string)) : { body: row };
      return undefined;
    };

  it("PUTs only the changed fields of the active tab", async () => {
    mockFetch(settingsApi(), ["settings.read", "settings.write"]);
    renderApp("/settings");
    const u = userEvent.setup();
    const name = await screen.findByLabelText("Store name");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await u.clear(name);
    await u.type(name, "Aadhya Studio");
    await u.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(lastCall("PUT", "/settings")).toBeTruthy());
    expect(lastCall("PUT", "/settings")!.body).toEqual({ name: "Aadhya Studio" });

    await u.click(screen.getByRole("tab", { name: /Feature flags/ }));
    await u.click(screen.getByLabelText("Blog"));
    await u.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(lastCall("PUT", "/settings")!.body).toEqual({ features: { blog: false } });
  });

  it("validates client-side and maps API field errors", async () => {
    mockFetch(
      settingsApi(() => ({
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request",
            details: [{ path: "supportEmail", message: "Invalid email" }],
          },
        },
      })),
      ["settings.read", "settings.write"],
    );
    renderApp("/settings");
    const u = userEvent.setup();
    const email = await screen.findByLabelText("Support email");
    await u.clear(email);
    await u.type(email, "nope");
    await u.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(lastCall("PUT", "/settings")).toBeUndefined();
    await u.clear(email);
    await u.type(email, "ok@x.test");
    await u.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Invalid email")).toBeInTheDocument();
  });

  it("is read-only without settings.write", async () => {
    mockFetch(settingsApi(), ["settings.read"]);
    renderApp("/settings");
    expect(await screen.findByLabelText("Store name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("buildPayload covers tax and social diffs", () => {
    const base = toState(row);
    const cur = structuredClone(base);
    cur.tax.defaultRate = "12";
    cur.social = { instagram: " https://instagram.com/x ", facebook: "" };
    expect(buildPayload("tax", base, cur)).toEqual({ tax: { defaultRate: 12 } });
    expect(buildPayload("social", base, cur)).toEqual({
      social: { instagram: "https://instagram.com/x" },
    });
    expect(buildPayload("general", base, cur)).toEqual({});
  });
});

describe("seo defaults", () => {
  const seo = {
    titleTemplate: "%s",
    defaultTitle: "",
    defaultDescription: "",
    defaultOgImageMediaId: null,
    robots: "index",
    siteUrl: null,
  };
  const seoApi: Handler = (_u, init, path) => {
    if (path === "/seo" && (init.method ?? "GET") === "GET") return { body: seo };
    if (path === "/seo" && init.method === "PUT")
      return { body: { ...seo, ...JSON.parse(init.body as string) } };
    return undefined;
  };
  it("rejects a template without %s and PUTs only changed keys", async () => {
    mockFetch(seoApi, ["seo.write", "media.read"]);
    renderApp("/seo");
    const u = userEvent.setup();
    const tpl = await screen.findByLabelText("Title template");
    await u.clear(tpl);
    await u.type(tpl, "My Store");
    await u.click(screen.getByRole("button", { name: "Save SEO defaults" }));
    expect(await screen.findByText(/Must contain %s/)).toBeInTheDocument();
    expect(lastCall("PUT", "/seo")).toBeUndefined();

    await u.clear(tpl);
    await u.type(tpl, "%s | My Store");
    await u.selectOptions(screen.getByLabelText("Search engine visibility"), "noindex");
    await u.click(screen.getByRole("button", { name: "Save SEO defaults" }));
    await waitFor(() => expect(lastCall("PUT", "/seo")).toBeTruthy());
    expect(lastCall("PUT", "/seo")!.body).toEqual({
      titleTemplate: "%s | My Store",
      robots: "noindex",
    });
  });
});
