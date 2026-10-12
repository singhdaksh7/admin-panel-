import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lastCall, mockFetch, paginated, renderApp, type Handler } from "./growth-helpers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const media = {
  id: "m1",
  url: "http://x/a.png",
  filename: "a.png",
  mimeType: "image/png",
  sizeBytes: 2048,
  width: 10,
  height: 10,
  altText: null,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("media library", () => {
  const mediaApi: Handler = (_u, init, path) => {
    const method = init.method ?? "GET";
    if (path.startsWith("/media?")) return { body: paginated([media]) };
    if (path === "/media/m1" && method === "GET")
      return {
        body: { ...media, references: [{ entity: "BlogPost", field: "coverMediaId", count: 2 }] },
      };
    if (path === "/media/m1" && method === "PATCH")
      return { body: { ...media, altText: "A logo" } };
    if (path === "/media/m1" && method === "DELETE")
      return {
        status: 409,
        body: {
          error: {
            code: "CONFLICT",
            message: "Media is in use and cannot be deleted",
            details: [{ entity: "BlogPost", field: "coverMediaId", count: 2 }],
          },
        },
      };
    return undefined;
  };

  it("edits alt text and explains why an in-use image cannot be deleted", async () => {
    mockFetch(mediaApi, ["media.read", "media.write"]);
    renderApp("/media");
    const u = userEvent.setup();
    await u.click(await screen.findByTitle("a.png"));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/BlogPost\.coverMediaId \(2\)/);
    await u.type(within(dialog).getByLabelText("Alt text"), "A logo");
    await u.click(within(dialog).getByRole("button", { name: "Save alt text" }));
    await waitFor(() => expect(lastCall("PATCH", "/media/m1")).toBeTruthy());
    expect(lastCall("PATCH", "/media/m1")!.body).toEqual({ altText: "A logo" });

    await u.click(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = (await screen.findAllByRole("dialog")).at(-1)!;
    await u.click(within(confirm).getByRole("button", { name: "Delete" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Media is in use and cannot be deleted");
    expect(alert).toHaveTextContent("BlogPost.coverMediaId: 2 references");
  });

  it("hides upload and delete without media.write", async () => {
    mockFetch(mediaApi, ["media.read"]);
    renderApp("/media");
    await screen.findByTitle("a.png");
    expect(screen.queryByRole("button", { name: "Upload images" })).not.toBeInTheDocument();
  });
});

describe("blog", () => {
  const blogApi: Handler = (_u, init, path) => {
    if (path.startsWith("/blog?")) return { body: paginated([]) };
    if (path === "/blog" && init.method === "POST") return { status: 201, body: { id: "b1" } };
    return undefined;
  };
  it("creates a post with parsed tags and a derived slug", async () => {
    mockFetch(blogApi, ["content.read", "blog.write", "media.read"]);
    renderApp("/blog/new");
    const u = userEvent.setup();
    await u.click(await screen.findByRole("button", { name: "Create post" }));
    expect(await screen.findByText("Title is required")).toBeInTheDocument();
    await u.type(screen.getByLabelText("Title"), "Hello World");
    expect(screen.getByLabelText("Slug")).toHaveValue("hello-world");
    await u.type(screen.getByLabelText("Tags"), "news, launch ,");
    await u.click(screen.getByRole("button", { name: "Create post" }));
    await waitFor(() => expect(lastCall("POST", "/blog")).toBeTruthy());
    expect(lastCall("POST", "/blog")!.body).toEqual({
      title: "Hello World",
      slug: "hello-world",
      excerpt: null,
      body: "",
      coverMediaId: null,
      authorName: null,
      status: "DRAFT",
      publishAt: null,
      seo: null,
      tags: ["news", "launch"],
    });
  });
});
