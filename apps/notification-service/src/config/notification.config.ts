import Joi from 'joi';

import {
  BaseConfig,
  DatabaseConfig,
  RabbitMQConfig,
  baseConfigSchema,
  databaseConfigSchema,
  rabbitmqConfigSchema,
} from '@core/config';

export interface NotificationConfig
  extends BaseConfig, DatabaseConfig, RabbitMQConfig {
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_SECURE?: boolean;
  SMTP_FROM: string;

  /** Base URL used to render confirmation links. */
  APP_PUBLIC_URL: string;
}

export const notificationConfigSchema = Joi.object<NotificationConfig>({
  ...baseConfigSchema,
  ...databaseConfigSchema,
  ...rabbitmqConfigSchema,

  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().port().required(),
  // Optional: Mailhog accepts anonymous SMTP locally, turboSMTP does not.
  SMTP_USER: Joi.string().optional().allow(''),
  SMTP_PASSWORD: Joi.string().optional().allow(''),
  SMTP_SECURE: Joi.boolean().optional().default(false),
  // `tlds: false` because Joi otherwise checks the domain against the IANA
  // list, which refuses the `.local` sender the compose stack is configured
  // with — the service would not boot on its own defaults.
  SMTP_FROM: Joi.string()
    .email({ tlds: { allow: false } })
    .required(),

  APP_PUBLIC_URL: Joi.string().uri().required(),
});
