import Joi from 'joi';

import type { StorageDriverName } from './file-storage';

export interface StorageConfig {
  /** Where new files go. Existing files are read from wherever they were put. */
  STORAGE_DRIVER: StorageDriverName;
  /** The directory the `local` driver keeps its buckets in. */
  STORAGE_LOCAL_ROOT: string;

  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_BUCKET_UPLOADS?: string;
  S3_BUCKET_RESULTS?: string;
  /** MinIO needs path-style addressing; real S3 does not. */
  S3_FORCE_PATH_STYLE?: boolean;
  /** Lifetime of a presigned download URL, in seconds. */
  S3_PRESIGN_TTL?: number;
}

/** Required when S3 is where files go; optional otherwise. */
const whenS3 = (schema: Joi.Schema) =>
  schema.when('STORAGE_DRIVER', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional(),
  });

/**
 * Spread into each service's own Joi schema. The S3 credentials are required
 * only when S3 is the active driver — but configuring them alongside `local`
 * keeps files written under S3 readable after a switch.
 */
export const storageConfigSchema = {
  STORAGE_DRIVER: Joi.string().valid('s3', 'local').optional().default('s3'),
  STORAGE_LOCAL_ROOT: Joi.string().optional().default('./.storage'),

  S3_ENDPOINT: whenS3(Joi.string().uri()),
  S3_REGION: Joi.string().optional().default('us-east-1'),
  S3_ACCESS_KEY: whenS3(Joi.string()),
  S3_SECRET_KEY: whenS3(Joi.string()),
  S3_BUCKET_UPLOADS: whenS3(Joi.string()),
  S3_BUCKET_RESULTS: whenS3(Joi.string()),
  S3_FORCE_PATH_STYLE: Joi.boolean().optional().default(true),
  S3_PRESIGN_TTL: Joi.number().min(60).max(3600).optional().default(300),
};
