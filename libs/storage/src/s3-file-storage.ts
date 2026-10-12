import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { ConfigService } from '@core/config/config.service';
import {
  FileStorage,
  ObjectNotFoundError,
  type PutObjectInput,
  type StorageBucket,
} from './file-storage';
import type { StorageConfig } from './storage.config';

/** S3 and anything that speaks it — MinIO locally. */
export class S3FileStorage extends FileStorage {
  readonly driver = 's3' as const;

  constructor(
    private readonly client: S3Client,
    private readonly config: ConfigService<StorageConfig>,
  ) {
    super();
  }

  async put(input: PutObjectInput): Promise<void> {
    const params = {
      Bucket: this.bucketName(input.bucket),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    };

    // A stream of unknown length — an upload still arriving — cannot go in
    // one PutObject: S3 wants the length first. The multipart Upload sends it
    // in parts as it arrives, so the gateway never holds the whole file.
    if (input.body instanceof Readable && input.contentLength === undefined) {
      await new Upload({ client: this.client, params }).done();

      return;
    }

    await this.client.send(
      new PutObjectCommand({ ...params, ContentLength: input.contentLength }),
    );
  }

  async getStream(bucket: StorageBucket, key: string): Promise<Readable> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
      );

      return response.Body as Readable;
    } catch (error) {
      if (isMissing(error)) {
        throw new ObjectNotFoundError(bucket, key);
      }

      throw error;
    }
  }

  async presignGet(
    bucket: StorageBucket,
    key: string,
    ttlSeconds?: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
      { expiresIn: ttlSeconds ?? this.config.getNumber('S3_PRESIGN_TTL') },
    );
  }

  async delete(bucket: StorageBucket, key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
    );
  }

  async ping(): Promise<void> {
    await this.client.send(
      new HeadBucketCommand({ Bucket: this.bucketName('uploads') }),
    );
  }

  private bucketName(bucket: StorageBucket): string {
    return bucket === 'uploads'
      ? this.config.get('S3_BUCKET_UPLOADS')
      : this.config.get('S3_BUCKET_RESULTS');
  }
}

function isMissing(error: unknown): boolean {
  const failure = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };

  return (
    failure?.name === 'NoSuchKey' ||
    failure?.name === 'NotFound' ||
    failure?.$metadata?.httpStatusCode === 404
  );
}
