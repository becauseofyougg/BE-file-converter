/**
 * Config fragments shared by every service.
 *
 * Each app composes the fragments it actually needs into its own `Config`
 * interface (see `apps/<app>/src/config`), so the conversion worker does not
 * require SMTP credentials to boot and the gateway does not require a database.
 */

export type NodeEnv = 'development' | 'production' | 'test';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface BaseConfig {
  NODE_ENV: NodeEnv;

  /**
   * Logical service name — used as the `service` field of every log line.
   */
  SERVICE_NAME: string;

  /**
   * HTTP port. Workers expose HTTP for `/health` only.
   */
  PORT: number;

  LOG_LEVEL: LogLevel;

  /**
   * Health check options
   */
  HEALTH_CHECK_ENABLED?: boolean;
}

export interface HttpEdgeConfig {
  /**
   * Cookie secret
   */
  COOKIE_SECRET: string;

  /**
   * Comma-separated CORS allow-list. Never `*`.
   */
  CORS_ORIGINS: string;
}

export interface ThrottlerConfig {
  THROTTLE_GLOBAL_TTL?: number;
  THROTTLE_GLOBAL_LIMIT?: number;
}

export interface PostgresConfig {
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  POSTGRES_SYNCHRONIZE?: boolean;
  POSTGRES_LOGGING?: boolean;
  POSTGRES_MIGRATIONS_RUN?: boolean;
}

export interface RabbitMQConfig {
  RABBITMQ_URL: string;

  /**
   * How many unacked messages a consumer may hold. `1` on the converters, so a
   * crash redelivers exactly one job.
   */
  RABBITMQ_PREFETCH?: number;
}
