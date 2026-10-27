import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  FileStorage,
  ObjectNotFoundError,
  type PutObjectInput,
  type StorageBucket,
} from './file-storage';

const BUCKETS: readonly StorageBucket[] = ['uploads', 'results'];

/**
 * What a key may look like: slash-separated segments of safe characters, none
 * starting with a dot. Keys are built by the services from ids, never from a
 * client's filename, so anything else is a bug — and here, a path traversal.
 */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * A directory on disk — one subdirectory per bucket.
 *
 * Every service that touches the same files must see the same directory: in
 * the compose stack that is a volume shared by the gateway and the converter.
 */
export class LocalFileStorage extends FileStorage {
  readonly driver = 'local' as const;

  private readonly root: string;

  constructor(root: string) {
    super();
    this.root = resolve(root);
  }

  async put(input: PutObjectInput): Promise<void> {
    const target = this.pathFor(input.bucket, input.key);
    // Written beside the target and renamed into place, so a reader never sees
    // half a file and a failed write leaves nothing behind.
    const partial = `${target}.${randomUUID()}.part`;

    await mkdir(dirname(target), { recursive: true });

    try {
      if (Buffer.isBuffer(input.body)) {
        await writeFile(partial, input.body);
      } else {
        await pipeline(input.body, createWriteStream(partial));
      }

      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });

      throw error;
    }
  }

  async getStream(bucket: StorageBucket, key: string): Promise<Readable> {
    const path = this.pathFor(bucket, key);

    try {
      await access(path, fsConstants.R_OK);
    } catch {
      throw new ObjectNotFoundError(bucket, key);
    }

    return createReadStream(path);
  }

  async delete(bucket: StorageBucket, key: string): Promise<void> {
    await rm(this.pathFor(bucket, key), { force: true });
  }

  /** Both bucket directories exist and are writable. */
  async ping(): Promise<void> {
    for (const bucket of BUCKETS) {
      const directory = resolve(this.root, bucket);

      await mkdir(directory, { recursive: true });
      await access(directory, fsConstants.W_OK);
    }
  }

  /** A directory has no URL of its own; the caller streams the bytes. */
  presignGet(): Promise<null> {
    return Promise.resolve(null);
  }

  /**
   * The key checked twice: against the pattern, and — in case the pattern is
   * ever loosened — by confirming the resolved path is still under the bucket.
   */
  private pathFor(bucket: StorageBucket, key: string): string {
    if (!BUCKETS.includes(bucket) || !SAFE_KEY.test(key)) {
      throw new Error(`Refusing an unsafe storage key: ${bucket}/${key}`);
    }

    const base = resolve(this.root, bucket);
    const path = resolve(base, ...key.split('/'));

    if (!path.startsWith(`${base}${sep}`)) {
      throw new Error(`Refusing an unsafe storage key: ${bucket}/${key}`);
    }

    return path;
  }
}
