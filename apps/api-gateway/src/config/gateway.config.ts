import Joi from 'joi';

import {
  BaseConfig,
  HttpEdgeConfig,
  RabbitMQConfig,
  ThrottlerConfig,
  baseConfigSchema,
  httpEdgeConfigSchema,
  rabbitmqConfigSchema,
  throttlerConfigSchema,
} from '@core/config';
import { S3Config, s3ConfigSchema } from '@storage/storage.config';

/**
 * The gateway owns no domain data, so it declares no database variables — it
 * cannot accidentally reach into another service's schema.
 */
export interface GatewayConfig
  extends
    BaseConfig,
    HttpEdgeConfig,
    ThrottlerConfig,
    RabbitMQConfig,
    S3Config {}

export const gatewayConfigSchema = Joi.object<GatewayConfig>({
  ...baseConfigSchema,
  ...httpEdgeConfigSchema,
  ...throttlerConfigSchema,
  ...rabbitmqConfigSchema,
  ...s3ConfigSchema,
});
