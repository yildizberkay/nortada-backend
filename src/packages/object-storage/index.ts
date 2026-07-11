import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { globalConfig } from "@/app/global-config";
import { GenericError } from "@/packages/error";
import { createLogger } from "@/packages/logger";

const logger = createLogger("object-storage");

export interface PutOptions {
  contentType?: string;
  contentEncoding?: string;
}

/**
 * Blob-storage port (S3 / R2 / MinIO-compatible). The only large-object store in
 * Splash today is the raw GPS track (RFC-0006 L0), which is too big to belong in
 * Postgres. Services depend on this interface, never the concrete client.
 */
export interface ObjectStorage {
  put(key: string, body: Buffer, options?: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/**
 * S3-compatible `ObjectStorage`. Config (bucket/region/credentials/endpoint) is
 * read lazily on first use — `new S3ObjectStorage()` stays config-free so it can
 * be constructed at `buildContainer` time (before `globalConfig.initialize()`),
 * matching `OpenMeteoClient`. Endpoint + forcePathStyle make it R2/MinIO-ready.
 */
export class S3ObjectStorage implements ObjectStorage {
  private _client?: S3Client;
  private _bucket?: string;

  private get client(): S3Client {
    if (!this._client) {
      const cfg = globalConfig.config.objectStorage;
      if (!cfg.bucket) {
        throw new GenericError("EXTERNAL_SERVICE_ERROR", {
          message: "Object storage is not configured (OBJECT_STORAGE_BUCKET)",
        });
      }
      this._bucket = cfg.bucket;
      this._client = new S3Client({
        region: cfg.region,
        ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
        ...(cfg.forcePathStyle ? { forcePathStyle: true } : {}),
        ...(cfg.accessKeyId && cfg.secretAccessKey
          ? {
              credentials: {
                accessKeyId: cfg.accessKeyId,
                secretAccessKey: cfg.secretAccessKey,
              },
            }
          : {}),
      });
    }
    return this._client;
  }

  private get bucket(): string {
    // Touch `client` first so `_bucket` is populated together with the client.
    void this.client;
    return this._bucket as string;
  }

  async put(key: string, body: Buffer, options?: PutOptions): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: options?.contentType,
          ContentEncoding: options?.contentEncoding,
        }),
      );
    } catch (error) {
      if (error instanceof GenericError) throw error;
      logger.error("Object storage put failed", { key, error });
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        message: "Failed to store object",
      });
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) {
        throw new GenericError("EXTERNAL_SERVICE_ERROR", {
          message: "Object body was empty",
        });
      }
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof GenericError) throw error;
      logger.error("Object storage get failed", { key, error });
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        message: "Failed to read object",
      });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (error instanceof GenericError) throw error;
      logger.error("Object storage delete failed", { key, error });
      throw new GenericError("EXTERNAL_SERVICE_ERROR", {
        message: "Failed to delete object",
      });
    }
  }
}
