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
import { S3Config, s3ConfigSchema } from '@storage/storage.config';

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
    S3Config {}

export const gatewayConfigSchema = Joi.object<GatewayConfig>({
  ...baseConfigSchema,
  ...httpEdgeConfigSchema,
  ...jwtVerifyConfigSchema,
  ...throttlerConfigSchema,
  ...rabbitmqConfigSchema,
  ...s3ConfigSchema,
});
