import { FormatFamily } from '@contracts/enums/conversion.enums';

import { conversionConfigSchema } from '../../../conversion-service/src/config/conversion.config';
import { notificationConfigSchema } from '../../../notification-service/src/config/notification.config';
import { gatewayConfigSchema } from './gateway.config';

const S3 = {
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET_UPLOADS: 'uploads',
  S3_BUCKET_RESULTS: 'results',
};

const BASE = {
  NODE_ENV: 'test',
  PORT: 3000,
  RABBITMQ_URL: 'amqp://localhost:5672',
};

const DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/db';

/**
 * Each service composes only the fragments it needs, which is what stops the
 * conversion worker requiring SMTP credentials to boot and the gateway
 * requiring a database.
 */
describe('gatewayConfigSchema', () => {
  const VALID = {
    ...BASE,
    ...S3,
    SERVICE_NAME: 'api-gateway',
    COOKIE_SECRET: 'c'.repeat(32),
    CORS_ORIGINS: 'http://localhost:5174',
    JWT_SECRET: 'j'.repeat(40),
  };

  const validate = (overrides: Record<string, unknown> = {}) =>
    gatewayConfigSchema.validate({ ...VALID, ...overrides });

  it('accepts a minimal valid environment', () => {
    expect(validate().error).toBeUndefined();
  });

  /**
   * The gateway owns no domain data, so it declares no database variables —
   * and the schema *refuses* one, which is what makes "it cannot accidentally
   * reach into another service's schema" a fact rather than an intention.
   */
  it('refuses a database url outright', () => {
    expect(validate({ DATABASE_URL }).error?.message).toContain('DATABASE_URL');
  });

  it('needs the secret it verifies tokens with', () => {
    expect(validate({ JWT_SECRET: undefined }).error).toBeDefined();
  });

  /** The API uses credentialed requests, for which a wildcard is invalid. */
  it('refuses a wildcard CORS origin', () => {
    expect(validate({ CORS_ORIGINS: '*' }).error?.message).toContain('*');
  });

  it('refuses an empty CORS list', () => {
    expect(validate({ CORS_ORIGINS: ' , ' }).error).toBeDefined();
  });

  it('accepts several origins', () => {
    expect(
      validate({ CORS_ORIGINS: 'https://a.example, https://b.example' }).error,
    ).toBeUndefined();
  });

  describe('the storage fragment', () => {
    it('defaults the region and path-style for MinIO', () => {
      const { value } = validate();

      expect(value.S3_REGION).toBe('us-east-1');
      expect(value.S3_FORCE_PATH_STYLE).toBe(true);
    });

    /** A link that lives an hour is a link that gets forwarded. */
    it('bounds the presign lifetime at both ends', () => {
      expect(validate({ S3_PRESIGN_TTL: 30 }).error).toBeDefined();
      expect(validate({ S3_PRESIGN_TTL: 7200 }).error).toBeDefined();
      expect(validate({ S3_PRESIGN_TTL: 300 }).error).toBeUndefined();
    });

    it('needs both buckets, which are not interchangeable', () => {
      expect(validate({ S3_BUCKET_RESULTS: undefined }).error).toBeDefined();
    });
  });
});

describe('conversionConfigSchema', () => {
  const VALID = {
    ...BASE,
    ...S3,
    DATABASE_URL,
    SERVICE_NAME: 'conversion-service',
    CONVERSION_FAMILY: FormatFamily.IMAGE,
  };

  const validate = (overrides: Record<string, unknown> = {}) =>
    conversionConfigSchema.validate({ ...VALID, ...overrides });

  it('accepts a minimal valid environment', () => {
    expect(validate().error).toBeUndefined();
  });

  /**
   * It decides the queue the worker binds to *and* which binaries its image
   * ships, so there is no sensible default.
   */
  it('requires the family this replica consumes', () => {
    expect(validate({ CONVERSION_FAMILY: undefined }).error).toBeDefined();
  });

  it('refuses a family nothing converts', () => {
    expect(validate({ CONVERSION_FAMILY: 'hologram' }).error).toBeDefined();
  });

  it('sets the documented job limits by default', () => {
    const { value } = validate();

    expect(value.CONVERSION_TIMEOUT_MS).toBe(600_000);
    expect(value.CONVERSION_MAX_SOURCE_BYTES).toBe(100 * 1024 * 1024);
    expect(value.CONVERSION_RESULT_TTL_HOURS).toBe(24);
  });
});

describe('notificationConfigSchema', () => {
  const VALID = {
    ...BASE,
    DATABASE_URL,
    SERVICE_NAME: 'notification-service',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: 587,
    SMTP_FROM: 'no-reply@example.com',
    APP_PUBLIC_URL: 'https://app.example.com',
  };

  const validate = (overrides: Record<string, unknown> = {}) =>
    notificationConfigSchema.validate({ ...VALID, ...overrides });

  it('accepts a minimal valid environment', () => {
    expect(validate().error).toBeUndefined();
  });

  it('needs somewhere to send mail from', () => {
    expect(validate({ SMTP_FROM: undefined }).error).toBeDefined();
    expect(validate({ SMTP_HOST: undefined }).error).toBeDefined();
  });

  /** Confirmation links are rendered against it; a wrong one sends users nowhere. */
  it('needs the public URL links are built from', () => {
    expect(validate({ APP_PUBLIC_URL: undefined }).error).toBeDefined();
  });

  it('needs no S3 credentials, because it stores nothing', () => {
    expect(validate().error).toBeUndefined();
  });
});
