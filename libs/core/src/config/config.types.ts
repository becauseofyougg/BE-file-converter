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

  /**
   * Session cookie attributes — docs/AUTHORIZATION.md §3. They are deployment
   * facts, not code: the same build serves an API on the site's own domain and
   * one on a separate origin, and only the second needs `SameSite=None`.
   */
  COOKIE_DOMAIN?: string;

  /**
   * `strict` unless the browser has to send the cookie across origins, which
   * then requires `none` *and* `COOKIE_SECURE=true`. `SameSite` is the whole
   * CSRF defence for a cookie-authenticated API, so loosening it is a decision,
   * not a default.
   */
  COOKIE_SAMESITE?: 'lax' | 'strict' | 'none';

  /** Defaults to true in production, false elsewhere, so http://localhost works. */
  COOKIE_SECURE?: boolean;
}

/**
 * What a service needs to *verify* an access token. Identity signs them and
 * declares more (TTLs, refresh lifetime); the gateway only checks signatures,
 * so it takes the secret and nothing else.
 */
export interface JwtVerifyConfig {
  JWT_SECRET: string;
}

export interface ThrottlerConfig {
  THROTTLE_GLOBAL_TTL?: number;
  THROTTLE_GLOBAL_LIMIT?: number;
}

export interface DatabaseConfig {
  /**
   * Prisma connects by URL, and the same value is what the CLI reads when
   * running migrations — one variable rather than five that have to be
   * assembled identically in two places.
   *
   * Database per service: this points at `identity`, `conversion` or
   * `notification`, never at another service's schema.
   */
  DATABASE_URL: string;

  /** Logs every statement. Development only — queries carry user data. */
  DATABASE_LOG_QUERIES?: boolean;
}

export interface RabbitMQConfig {
  RABBITMQ_URL: string;

  /**
   * How many unacked messages a consumer may hold. `1` on the converters, so a
   * crash redelivers exactly one job.
   */
  RABBITMQ_PREFETCH?: number;
}
