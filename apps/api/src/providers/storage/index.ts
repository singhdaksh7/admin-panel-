import fs from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import type { StorageProvider } from "@kash-commerce/provider-sdk";

/** Storage keys are server-generated: 32 hex chars + a whitelisted image extension. */
export const STORAGE_KEY_RE = /^[a-f0-9]{32}\.(jpg|png|webp|gif|avif)$/;

export function isValidStorageKey(key: string): boolean {
  return STORAGE_KEY_RE.test(key);
}

export class LocalStorageProvider implements StorageProvider {
  readonly key = "LOCAL" as const;
  private readonly root: string;

  constructor(
    uploadDir: string,
    private readonly publicBaseUrl: string,
  ) {
    this.root = path.resolve(uploadDir);
  }

  /** Resolve a key to an absolute path, refusing anything that could escape the root. */
  private resolve(key: string): string {
    if (!isValidStorageKey(key)) throw new Error("Invalid storage key");
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(full, data, { flag: "wx" });
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  url(key: string): string {
    return `${this.publicBaseUrl.replace(/\/+$/, "")}/api/v1/media/files/${key}`;
  }

  async read(key: string): Promise<Buffer | null> {
    if (!isValidStorageKey(key)) return null;
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }
}

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL (CDN / r2.dev / bucket URL). Falls back to endpoint/bucket. */
  publicBaseUrl?: string;
  forcePathStyle?: boolean;
}

/** Minimal client surface so tests can inject a mock. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export class S3CompatibleStorageProvider implements StorageProvider {
  readonly key = "S3" as const;
  private readonly client: S3Like;

  constructor(
    private readonly opts: S3StorageOptions,
    client?: S3Like,
  ) {
    const cfg: S3ClientConfig = {
      region: opts.region,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // custom endpoints (MinIO / R2) generally need path-style addressing
      forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    };
    this.client = client ?? (new S3Client(cfg) as unknown as S3Like);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    if (!isValidStorageKey(key)) throw new Error("Invalid storage key");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
  }

  async delete(key: string): Promise<void> {
    if (!isValidStorageKey(key)) throw new Error("Invalid storage key");
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }

  url(key: string): string {
    if (this.opts.publicBaseUrl) return `${this.opts.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
    if (this.opts.endpoint)
      return `${this.opts.endpoint.replace(/\/+$/, "")}/${this.opts.bucket}/${key}`;
    return `https://${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com/${key}`;
  }
}
