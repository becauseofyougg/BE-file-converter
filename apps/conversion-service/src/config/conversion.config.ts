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
import { StorageConfig, storageConfigSchema } from '@storage/storage.config';

export interface ConversionConfig
  extends BaseConfig, DatabaseConfig, RabbitMQConfig, StorageConfig {
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

  /** Synchronous conversions (`conversion.rpc`) handled at once by a replica. */
  CONVERSION_RPC_CONCURRENCY?: number;

  /** A synchronous conversion is abandoned after this, with a 422. */
  CONVERSION_SYNC_TIMEOUT_MS?: number;

  /**
   * Largest source accepted, in bytes, for a format with no limit of its own.
   * A format gets its own as `CONVERSION_MAX_BYTES_<FORMAT>` —
   * `CONVERSION_MAX_BYTES_XML=2097152` — read by `ConversionLimits`.
   */
  CONVERSION_MAX_BYTES_DEFAULT?: number;

  /** Deepest nesting of objects and lists a data file may have. */
  CONVERSION_MAX_DEPTH?: number;

  /** Heap a conversion's worker thread may use before it is stopped. */
  CONVERSION_WORKER_MEMORY_MB?: number;

  /**
   * How long a result nobody asked to save is kept, so the gateway can stream
   * it, before the cleanup job deletes it.
   */
  CONVERSION_UNSAVED_RESULT_MINUTES?: number;
}

/** `CONVERSION_MAX_BYTES_CSV`, `CONVERSION_MAX_BYTES_YAML`, … */
export const PER_FORMAT_LIMIT_PATTERN =
  /^CONVERSION_MAX_BYTES_(?!DEFAULT$)[A-Z0-9]+$/;

export function perFormatLimitKey(format: string): string {
  return `CONVERSION_MAX_BYTES_${format.toUpperCase()}`;
}

export const conversionConfigSchema = Joi.object<ConversionConfig>({
  ...baseConfigSchema,
  ...databaseConfigSchema,
  ...rabbitmqConfigSchema,
  ...storageConfigSchema,

  CONVERSION_FAMILY: Joi.string()
    .valid(...Object.values(FormatFamily))
    .required(),
  CONVERSION_TIMEOUT_MS: Joi.number().optional().default(600_000),
  CONVERSION_MAX_SOURCE_BYTES: Joi.number()
    .optional()
    .default(100 * 1024 * 1024),
  CONVERSION_RESULT_TTL_HOURS: Joi.number().optional().default(24),

  CONVERSION_RPC_CONCURRENCY: Joi.number()
    .integer()
    .min(1)
    .optional()
    .default(4),
  CONVERSION_SYNC_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1)
    .optional()
    .default(30_000),
  CONVERSION_MAX_BYTES_DEFAULT: Joi.number()
    .integer()
    .min(1)
    .optional()
    .default(10 * 1024 * 1024),
  CONVERSION_MAX_DEPTH: Joi.number().integer().min(1).optional().default(64),
  CONVERSION_WORKER_MEMORY_MB: Joi.number()
    .integer()
    .min(16)
    .optional()
    .default(256),
  CONVERSION_UNSAVED_RESULT_MINUTES: Joi.number()
    .integer()
    .min(1)
    .optional()
    .default(15),
})
  // Per-format limits are named by the format, so they cannot be listed here;
  // they are still checked, so `CONVERSION_MAX_BYTES_CSV=10mb` fails the boot.
  .pattern(PER_FORMAT_LIMIT_PATTERN, Joi.number().integer().min(1));
