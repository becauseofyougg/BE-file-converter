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

  COOKIE_DOMAIN: Joi.string().optional(),

  COOKIE_SAMESITE: Joi.string()
    .valid('lax', 'strict', 'none')
    .optional()
    .default('strict'),

  /**
   * Derived from `NODE_ENV` rather than defaulted to a constant: `true` would
   * make every cookie silently vanish on http://localhost, and `false` would
   * ship a production build that hands sessions to a plaintext connection.
   */
  COOKIE_SECURE: Joi.boolean()
    .optional()
    .when('COOKIE_SAMESITE', {
      is: 'none',
      // A browser drops a `SameSite=None` cookie that is not `Secure`, so
      // there is exactly one workable value here. Unset takes it; an explicit
      // `false` is a contradiction, and saying so at boot beats discovering it
      // as "nobody can log in" some time after the deploy.
      then: Joi.valid(true).default(true).messages({
        'any.only': 'COOKIE_SECURE must be true when COOKIE_SAMESITE is "none"',
      }),
      otherwise: Joi.boolean().default(
        (parent: { NODE_ENV?: string }) => parent.NODE_ENV === 'production',
      ),
    }),
};

export const jwtVerifyConfigSchema = {
  JWT_SECRET: Joi.string().min(32).required(),
};

export const throttlerConfigSchema = {
  THROTTLE_GLOBAL_TTL: Joi.number().optional().default(10000),
  THROTTLE_GLOBAL_LIMIT: Joi.number().optional().default(10),
};

export const databaseConfigSchema = {
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  DATABASE_LOG_QUERIES: Joi.boolean().optional().default(false),
};

export const rabbitmqConfigSchema = {
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),
  RABBITMQ_PREFETCH: Joi.number().min(1).optional().default(1),
};
