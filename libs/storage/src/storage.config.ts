import Joi from 'joi';

export interface S3Config {
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_BUCKET_UPLOADS: string;
  S3_BUCKET_RESULTS: string;
  /** MinIO needs path-style addressing; real S3 does not. */
  S3_FORCE_PATH_STYLE?: boolean;
  /** Lifetime of a presigned download URL, in seconds. */
  S3_PRESIGN_TTL?: number;
}

export const s3ConfigSchema = {
  S3_ENDPOINT: Joi.string().uri().required(),
  S3_REGION: Joi.string().optional().default('us-east-1'),
  S3_ACCESS_KEY: Joi.string().required(),
  S3_SECRET_KEY: Joi.string().required(),
  S3_BUCKET_UPLOADS: Joi.string().required(),
  S3_BUCKET_RESULTS: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.boolean().optional().default(true),
  S3_PRESIGN_TTL: Joi.number().min(60).max(3600).optional().default(300),
};
