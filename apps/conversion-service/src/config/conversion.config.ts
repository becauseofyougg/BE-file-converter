import Joi from 'joi';

import {
  BaseConfig,
  DatabaseConfig,
  RabbitMQConfig,
  baseConfigSchema,
  databaseConfigSchema,
  rabbitmqConfigSchema,
} from '@core/config';
import { FormatFamily } from '@contracts/enums/conversion.enums';
import { S3Config, s3ConfigSchema } from '@storage/storage.config';

export interface ConversionConfig
  extends BaseConfig, DatabaseConfig, RabbitMQConfig, S3Config {
  /**
   * Which family this replica consumes. It decides the queue the worker binds
   * to *and* which binaries its image has to ship — an `image` deployment does
   * not carry LibreOffice.
   */
  CONVERSION_FAMILY: FormatFamily;

  /** Hard per-job timeout in milliseconds. */
  CONVERSION_TIMEOUT_MS?: number;

  /** Hard source size cap in bytes. */
  CONVERSION_MAX_SOURCE_BYTES?: number;

  /** Result retention before the cleanup job marks the job EXPIRED. */
  CONVERSION_RESULT_TTL_HOURS?: number;
}

export const conversionConfigSchema = Joi.object<ConversionConfig>({
  ...baseConfigSchema,
  ...databaseConfigSchema,
  ...rabbitmqConfigSchema,
  ...s3ConfigSchema,

  CONVERSION_FAMILY: Joi.string()
    .valid(...Object.values(FormatFamily))
    .required(),
  CONVERSION_TIMEOUT_MS: Joi.number().optional().default(600_000),
  CONVERSION_MAX_SOURCE_BYTES: Joi.number()
    .optional()
    .default(100 * 1024 * 1024),
  CONVERSION_RESULT_TTL_HOURS: Joi.number().optional().default(24),
});
