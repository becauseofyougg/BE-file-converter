import Joi from 'joi';

/**
 * Reusable Joi fragments, one per config fragment in `config.types.ts`.
 *
 * They are plain schema maps rather than `Joi.object()`s so an app can spread
 * exactly the ones it needs:
 *
 * ```ts
 * Joi.object({ ...baseConfigSchema, ...postgresConfigSchema, MY_VAR: Joi.string().required() })
 * ```
 */

export const baseConfigSchema = {
  NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),
  SERVICE_NAME: Joi.string().required(),
  PORT: Joi.number().port().required(),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace')
    .optional()
    .default('info'),

  /**
   * Health check options
   */
  HEALTH_CHECK_ENABLED: Joi.boolean().optional().default(false),
};

export const httpEdgeConfigSchema = {
  /**
   * Cookie secret
   */
  COOKIE_SECRET: Joi.string().required(),

  /**
   * CORS allow-list. `*` is rejected outright — the API uses credentialed
   * requests, for which a wildcard is both insecure and invalid.
   */
  CORS_ORIGINS: Joi.string()
    .required()
    .custom((value: string, helpers) => {
      const origins = value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

      if (origins.length === 0 || origins.includes('*')) {
        return helpers.error('any.invalid');
      }

      return value;
    })
    .messages({
      'any.invalid':
        'CORS_ORIGINS must be a non-empty comma-separated list and must not contain "*"',
    }),
};

export const throttlerConfigSchema = {
  THROTTLE_GLOBAL_TTL: Joi.number().optional().default(10000),
  THROTTLE_GLOBAL_LIMIT: Joi.number().optional().default(10),
};

export const postgresConfigSchema = {
  POSTGRES_HOST: Joi.string().hostname().required(),
  POSTGRES_PORT: Joi.number().port().required(),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_SYNCHRONIZE: Joi.boolean().optional().default(false),
  POSTGRES_LOGGING: Joi.boolean().optional().default(false),
  POSTGRES_MIGRATIONS_RUN: Joi.boolean().optional().default(false),
};

export const rabbitmqConfigSchema = {
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),
  RABBITMQ_PREFETCH: Joi.number().min(1).optional().default(1),
};
