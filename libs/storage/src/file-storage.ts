import type { Readable } from 'node:stream';

export type StorageBucket = 'uploads' | 'results';

export const STORAGE_DRIVERS = ['s3', 'local'] as const;
export type StorageDriverName = (typeof STORAGE_DRIVERS)[number];

export interface PutObjectInput {
  bucket: StorageBucket;
  key: string;
  body: Readable | Buffer;
  contentType?: string;
  /** Known up front for a buffer; usually unknown for an upload in flight. */
  contentLength?: number;
}

/** The object is not there — a different failure from storage being down. */
export class ObjectNotFoundError extends Error {
  constructor(
    readonly bucket: StorageBucket,
    readonly key: string,
  ) {
    super(`No object at ${bucket}/${key}`);
    this.name = ObjectNotFoundError.name;
  }
}

/**
 * Where files live, whatever is behind it.
 *
 * Two implementations today — S3-compatible object storage and a local
 * directory — chosen per deployment by `STORAGE_DRIVER`. Consumers inject this
 * class and never learn which one they got; a third backend is a new subclass
 * and a line in `StorageModule`, with no consumer changing.
 *
 * Both buckets are private: nothing here is ever publicly readable.
 */
export abstract class FileStorage {
  /** Recorded alongside what is stored, so it can be found again later. */
  abstract readonly driver: StorageDriverName;

  abstract put(input: PutObjectInput): Promise<void>;

  /** Rejects with {@link ObjectNotFoundError} when there is nothing there. */
  abstract getStream(bucket: StorageBucket, key: string): Promise<Readable>;

  /** Idempotent: deleting what is already gone succeeds. */
  abstract delete(bucket: StorageBucket, key: string): Promise<void>;

  /** Readiness: can this service read and write storage at all? */
  abstract ping(): Promise<void>;

  /**
   * A short-lived URL the client can fetch directly, or `null` when the
   * backend cannot issue one — a local directory has no URL of its own, and
   * the caller streams the bytes instead.
   */
  abstract presignGet(
    bucket: StorageBucket,
    key: string,
    ttlSeconds?: number,
  ): Promise<string | null>;

  /**
   * The user id in the key makes ownership checks cheap and accidental
   * cross-user access structurally impossible. The client's filename is never
   * part of the key.
   */
  buildKey(userId: string, id: string, extension?: string): string {
    return extension ? `${userId}/${id}.${extension}` : `${userId}/${id}`;
  }
}
