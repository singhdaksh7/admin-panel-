import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { bootApp, createAdminWithRole, loginAdmin, prisma, request } from "./helpers";
import { LocalStorageProvider, S3CompatibleStorageProvider } from "../src/providers/storage";
import { detectImageType } from "../src/modules/media/service";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

let app: Awaited<ReturnType<typeof bootApp>>["app"];
let a: Awaited<ReturnType<Awaited<ReturnType<typeof bootApp>>["admin"]>>;
let dir: string;
const B = "/api/v1/admin";

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kc-uploads-"));
  process.env.UPLOAD_DIR = dir;
  process.env.MAX_UPLOAD_MB = "1";
  const boot = await bootApp();
  app = boot.app;
  a = await boot.admin();
});
afterAll(() => {
  delete process.env.UPLOAD_DIR;
  delete process.env.MAX_UPLOAD_MB;
  fs.rmSync(dir, { recursive: true, force: true });
});

const upload = (buf: Buffer, filename: string, contentType?: string) =>
  a.agent
    .post(`${B}/media`)
    .set("x-csrf-token", a.csrf)
    .attach("file", buf, { filename, ...(contentType ? { contentType } : {}) });

describe("media upload", () => {
  it("accepts a valid png, stores under a random key, serves it publicly", async () => {
    const r = await upload(PNG, "../../evil name.png", "image/png");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    expect(r.body.filename).toBe("evil name.png");
    const key = r.body.url.split("/").pop() as string;
    expect(key).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(fs.existsSync(path.join(dir, key))).toBe(true);

    const file = await request(app).get(`/api/v1/media/files/${key}`);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["cache-control"]).toMatch(/immutable/);
    expect(Buffer.compare(file.body, PNG)).toBe(0);

    const gif = await upload(GIF, "a.gif");
    expect(gif.status).toBe(201);
    expect(gif.body.mimeType).toBe("image/gif");
  });

  it("rejects spoofed, svg, mismatched and non-image uploads", async () => {
    expect((await upload(SVG, "x.svg", "image/svg+xml")).status).toBe(422);
    expect((await upload(SVG, "x.png", "image/png")).status).toBe(422); // svg disguised
    expect((await upload(Buffer.from("<?php echo 1;"), "shell.php.png", "image/png")).status).toBe(
      422,
    );
    expect((await upload(FAKE_JPEG, "photo.png", "image/png")).status).toBe(422); // jpeg bytes, png name
    expect((await upload(PNG, "photo.jpg", "image/jpeg")).status).toBe(422); // png bytes, jpg name
    expect((await upload(PNG, "photo.png", "image/jpeg")).status).toBe(422); // lying content-type
    expect((await upload(PNG, "photo", "image/png")).status).toBe(422); // no extension
    expect((await upload(PNG, "photo.php", "image/png")).status).toBe(422);
    const none = await a.agent.post(`${B}/media`).set("x-csrf-token", a.csrf);
    expect(none.status).toBe(400);
    expect(fs.readdirSync(dir).length).toBe(2); // nothing from rejected uploads
  });

  it("rejects oversize files", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(1.2 * 1024 * 1024)]);
    const r = await upload(big, "big.png", "image/png");
    expect(r.status).toBe(413);
  });

  it("detects magic bytes", () => {
    expect(detectImageType(PNG)).toBe("png");
    expect(detectImageType(GIF)).toBe("gif");
    expect(detectImageType(FAKE_JPEG)).toBe("jpeg");
    expect(detectImageType(SVG)).toBeNull();
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    expect(detectImageType(webp)).toBe("webp");
    const avif = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif"), Buffer.alloc(8)]);
    expect(detectImageType(avif)).toBe("avif");
  });

  it("lists, searches, updates alt text, and returns 404s", async () => {
    const list = await a.get(`${B}/media?q=evil`);
    expect(list.body.total).toBe(1);
    const id = list.body.items[0].id;
    const patched = await a.patch(`${B}/media/${id}`, { altText: "A pixel" });
    expect(patched.body.altText).toBe("A pixel");
    expect((await a.get(`${B}/media?q=pixel`)).body.total).toBe(1);
    expect((await a.get(`${B}/media/${id}`)).body.references).toEqual([]);
    expect((await a.get(`${B}/media/nope`)).status).toBe(404);
    expect((await request(app).get("/api/v1/media/files/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await request(app).get(`/api/v1/media/files/${"0".repeat(32)}.png`)).status).toBe(404);
  });

  it("blocks delete while referenced (409) and deletes once free", async () => {
    const m = (await upload(PNG, "ref.png", "image/png")).body;
    const p = await a.post(`${B}/products`, {
      title: "With image",
      price: "3",
      imageMediaIds: [m.id],
    });
    expect(p.status).toBe(201);
    expect(p.body.images[0].url).toBe(m.url);
    const blocked = await a.del(`${B}/media/${m.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details[0]).toMatchObject({ entity: "ProductImage" });

    // other reference kinds
    const m2 = (await upload(GIF, "cat.gif")).body;
    const cat = await a.post(`${B}/categories`, { name: "Imgcat", imageMediaId: m2.id });
    expect((await a.del(`${B}/media/${m2.id}`)).status).toBe(409);
    await a.patch(`${B}/categories/${cat.body.id}`, { imageMediaId: null });
    await prisma.blogPost.create({
      data: { slug: "b", title: "B", body: "x", coverMediaId: m2.id },
    });
    expect((await a.del(`${B}/media/${m2.id}`)).status).toBe(409);
    await prisma.blogPost.deleteMany();
    await prisma.storeSettings.upsert({
      where: { id: "store" },
      create: { id: "store", logoMediaId: m2.id },
      update: { logoMediaId: m2.id },
    });
    expect((await a.del(`${B}/media/${m2.id}`)).status).toBe(409);
    await prisma.storeSettings.update({ where: { id: "store" }, data: { logoMediaId: null } });
    const key = m2.url.split("/").pop();
    expect((await a.del(`${B}/media/${m2.id}`)).status).toBe(204);
    expect(fs.existsSync(path.join(dir, key))).toBe(false);

    // unknown media id in product payload is a validation error
    expect(
      (await a.post(`${B}/products`, { title: "bad", price: "1", imageMediaIds: ["nope"] })).status,
    ).toBe(422);
  });

  it("requires media permissions", async () => {
    await createAdminWithRole("SUPPORT", "media-sup@x.example");
    const sup = await loginAdmin(app, "media-sup@x.example", "Another-Pass-123");
    expect((await sup.get(`${B}/media`)).status).toBe(200);
    expect(
      (
        await sup.agent
          .post(`${B}/media`)
          .set("x-csrf-token", sup.csrf)
          .attach("file", PNG, "s.png")
      ).status,
    ).toBe(403);
    await createAdminWithRole("CONTENT_MANAGER", "media-cm@x.example");
    const cm = await loginAdmin(app, "media-cm@x.example", "Another-Pass-123");
    expect((await cm.get(`${B}/media`)).status).toBe(200);
    expect(
      (await cm.agent.post(`${B}/media`).set("x-csrf-token", cm.csrf).attach("file", PNG, "c.png"))
        .status,
    ).toBe(201);
  });
});

describe("storage providers", () => {
  it("local provider is traversal safe", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kc-local-"));
    const p = new LocalStorageProvider(tmp, "https://api.example.com/");
    const key = `${"a".repeat(32)}.png`;
    await p.put(key, PNG, "image/png");
    expect((await p.read(key))?.equals(PNG)).toBe(true);
    expect(p.url(key)).toBe(`https://api.example.com/api/v1/media/files/${key}`);
    await expect(p.put("../escape.png", PNG, "image/png")).rejects.toThrow();
    await expect(p.put(`..${path.sep}${key}`, PNG, "image/png")).rejects.toThrow();
    expect(await p.read("../../etc/passwd")).toBeNull();
    await p.delete(key);
    await p.delete(key); // idempotent
    expect(await p.read(key)).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("s3 provider issues Put/Delete commands and builds public urls", async () => {
    const send = vi.fn().mockResolvedValue({});
    const base = {
      bucket: "shop",
      region: "auto",
      accessKeyId: "k",
      secretAccessKey: "s",
    };
    const p = new S3CompatibleStorageProvider(
      {
        ...base,
        endpoint: "https://acct.r2.cloudflarestorage.com",
        publicBaseUrl: "https://cdn.example.com/",
      },
      { send },
    );
    const key = `${"b".repeat(32)}.webp`;
    await p.put(key, PNG, "image/webp");
    const put = send.mock.calls[0]![0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({ Bucket: "shop", Key: key, ContentType: "image/webp" });
    await p.delete(key);
    expect(send.mock.calls[1]![0]).toBeInstanceOf(DeleteObjectCommand);
    expect(p.url(key)).toBe(`https://cdn.example.com/${key}`);
    await expect(p.put("bad/../key", PNG, "image/png")).rejects.toThrow();

    const minio = new S3CompatibleStorageProvider(
      { ...base, endpoint: "http://minio:9000" },
      { send },
    );
    expect(minio.url(key)).toBe(`http://minio:9000/shop/${key}`);
    const aws = new S3CompatibleStorageProvider({ ...base, region: "eu-west-1" }, { send });
    expect(aws.url(key)).toBe(`https://shop.s3.eu-west-1.amazonaws.com/${key}`);
    expect(p.key).toBe("S3");
  });
});
