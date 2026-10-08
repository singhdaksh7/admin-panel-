export interface StorageProvider {
  readonly key: "LOCAL" | "S3";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Public URL for a stored key. */
  url(key: string): string;
  /** LOCAL only: read for serving. */
  read?(key: string): Promise<Buffer | null>;
}
