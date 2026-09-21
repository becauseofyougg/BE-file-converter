import { Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { ConfigService } from '@core/config/config.service';
import { S3Config } from './storage.config';
import { S3_CLIENT } from './storage.constants';

export type StorageBucket = 'uploads' | 'results';

export interface PutObjectInput {
  bucket: StorageBucket;
  key: string;
  body: Readable | Buffer;
  contentType?: string;
  contentLength?: number;
}

/**
 * The only place in the system that talks to object storage. Both buckets are
 * private — a result is delivered as a short-lived presigned URL, never as a
 * public object and never streamed back through Node.
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_CLIENT) private readonly client: S3Client,
    private readonly config: ConfigService<S3Config>,
  ) {}

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName(input.bucket),
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
    );
  }

  async getStream(bucket: StorageBucket, key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
    );

    return response.Body as Readable;
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

  /**
   * Readiness probe: can this service reach storage at all?
   */
  async ping(): Promise<void> {
    await this.client.send(
      new HeadBucketCommand({ Bucket: this.bucketName('uploads') }),
    );
  }

  /**
   * The user id in the key makes ownership checks cheap and accidental
   * cross-user access structurally impossible. The client's filename is never
   * part of the key.
   */
  buildKey(userId: string, jobId: string, extension?: string): string {
    return extension ? `${userId}/${jobId}.${extension}` : `${userId}/${jobId}`;
  }

  private bucketName(bucket: StorageBucket): string {
    return bucket === 'uploads'
      ? this.config.get('S3_BUCKET_UPLOADS')
      : this.config.get('S3_BUCKET_RESULTS');
  }
}
