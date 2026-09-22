import Joi from 'joi';

import {
  BaseConfig,
  DatabaseConfig,
  RabbitMQConfig,
  baseConfigSchema,
  databaseConfigSchema,
  rabbitmqConfigSchema,
} from '@core/config';

export interface IdentityConfig
  extends BaseConfig, DatabaseConfig, RabbitMQConfig {
  /**
   * Email confirmation, switchable per scenario — see docs/REGISTRATION.md §2.
   */
  AUTH_CONFIRM_REGISTRATION?: boolean;
  AUTH_CONFIRM_PASSWORD_RESET?: boolean;
  AUTH_CONFIRM_LOGIN?: boolean;
  AUTH_CONFIRM_METHOD?: 'otp' | 'link';

  /** Consecutive failed passwords before the account is locked. */
  LOGIN_MAX_FAILED_ATTEMPTS?: number;
  /** How long that lock lasts, in minutes. */
  LOGIN_LOCKOUT_MINUTES?: number;

  JWT_SECRET: string;
  JWT_ACCESS_TTL?: string;
  REFRESH_TOKEN_TTL_DAYS?: number;
}

export const identityConfigSchema = Joi.object<IdentityConfig>({
  ...baseConfigSchema,
  ...databaseConfigSchema,
  ...rabbitmqConfigSchema,

  AUTH_CONFIRM_REGISTRATION: Joi.boolean().optional().default(true),
  AUTH_CONFIRM_PASSWORD_RESET: Joi.boolean().optional().default(true),
  AUTH_CONFIRM_LOGIN: Joi.boolean().optional().default(false),
  AUTH_CONFIRM_METHOD: Joi.string()
    .valid('otp', 'link')
    .optional()
    .default('otp'),

  LOGIN_MAX_FAILED_ATTEMPTS: Joi.number().min(1).optional().default(5),
  LOGIN_LOCKOUT_MINUTES: Joi.number().min(1).optional().default(15),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().optional().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: Joi.number().optional().default(30),
});
