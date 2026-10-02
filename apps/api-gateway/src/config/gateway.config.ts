import Joi from 'joi';

import {
  BaseConfig,
  HttpEdgeConfig,
  JwtVerifyConfig,
  RabbitMQConfig,
  ThrottlerConfig,
  baseConfigSchema,
  httpEdgeConfigSchema,
  jwtVerifyConfigSchema,
  rabbitmqConfigSchema,
  throttlerConfigSchema,
} from '@core/config';
import { StorageConfig, storageConfigSchema } from '@storage/storage.config';

/**
 * The gateway owns no domain data, so it declares no database variables — it
 * cannot accidentally reach into another service's schema. It does hold
 * `JWT_SECRET`, because it is the enforcement point: verifying a token locally
 * is what keeps an identity round trip off every authenticated request.
 */
export interface GatewayConfig
  extends
    BaseConfig,
    HttpEdgeConfig,
    JwtVerifyConfig,
    ThrottlerConfig,
    RabbitMQConfig,
    StorageConfig {
  /**
   * The largest upload `POST /api/convert` reads, whatever the format — the
   * edge's own ceiling. The per-format limits are conversion-service's, and
   * lower; this one stops a client streaming gigabytes at the gateway before
   * anyone has looked at what they are.
   */
  CONVERSION_UPLOAD_MAX_BYTES?: number;

  /**
   * How long the gateway waits for a conversion. Longer than the service's
   * own limit (`CONVERSION_SYNC_TIMEOUT_MS`, 30 s), so the client gets that
   * limit's 422 rather than a 504 racing it.
   */
  CONVERSION_RPC_TIMEOUT_MS?: number;
}

export const gatewayConfigSchema = Joi.object<GatewayConfig>({
  ...baseConfigSchema,
  ...httpEdgeConfigSchema,
  ...jwtVerifyConfigSchema,
  ...throttlerConfigSchema,
  ...rabbitmqConfigSchema,
  ...storageConfigSchema,

  CONVERSION_UPLOAD_MAX_BYTES: Joi.number()
    .integer()
    .min(1)
    .optional()
    .default(50 * 1024 * 1024),
  CONVERSION_RPC_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .optional()
    .default(45_000),
});
