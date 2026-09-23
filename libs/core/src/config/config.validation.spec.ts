import Joi from 'joi';

import type { BaseConfig, HttpEdgeConfig } from './config.types';
import { baseConfigSchema, httpEdgeConfigSchema } from './config.validation';

/**
 * The cookie attributes decide whether a session survives the browser at all,
 * and both of their defaults are derived rather than constant — so they are
 * worth a test. Getting `COOKIE_SECURE` wrong fails in one of two silent ways:
 * no cookie is ever stored in development, or production hands sessions to a
 * plaintext connection.
 */
describe('httpEdgeConfigSchema', () => {
  const schema = Joi.object<BaseConfig & HttpEdgeConfig>({
    ...baseConfigSchema,
    ...httpEdgeConfigSchema,
  });

  const base = {
    NODE_ENV: 'development',
    SERVICE_NAME: 'api-gateway',
    PORT: 3000,
    COOKIE_SECRET: 'a'.repeat(32),
    CORS_ORIGINS: 'http://localhost:5174',
  };

  // Joi types the validated value as `any` whatever the schema's generic says,
  // so the shape is asserted once here rather than at every assertion below.
  const validate = (
    overrides: Record<string, unknown> = {},
  ): { error?: Joi.ValidationError; value: BaseConfig & HttpEdgeConfig } => {
    const result = schema.validate({ ...base, ...overrides });

    return {
      error: result.error,
      value: result.value as BaseConfig & HttpEdgeConfig,
    };
  };

  it('leaves cookies insecure outside production, so http://localhost works', () => {
    const { error, value } = validate();

    expect(error).toBeUndefined();
    expect(value.COOKIE_SECURE).toBe(false);
  });

  it('requires HTTPS for cookies in production without being told to', () => {
    const { value } = validate({ NODE_ENV: 'production' });

    expect(value.COOKIE_SECURE).toBe(true);
  });

  it('still lets a deployment say otherwise', () => {
    const { value } = validate({
      NODE_ENV: 'production',
      COOKIE_SECURE: false,
    });

    expect(value.COOKIE_SECURE).toBe(false);
  });

  it('defaults SameSite to strict — the CSRF defence is opt-out, not opt-in', () => {
    expect(validate().value.COOKIE_SAMESITE).toBe('strict');
  });

  /**
   * A browser drops a `SameSite=None` cookie that is not `Secure`, so there is
   * one workable value and an unset variable takes it — even in development,
   * where the plain default would be `false`.
   */
  it('forces Secure alongside SameSite=None', () => {
    const { error, value } = validate({ COOKIE_SAMESITE: 'none' });

    expect(error).toBeUndefined();
    expect(value.COOKIE_SECURE).toBe(true);
  });

  it('refuses the combination the browser would silently discard', () => {
    const { error } = validate({
      COOKIE_SAMESITE: 'none',
      COOKIE_SECURE: false,
    });

    expect(error?.message).toContain('COOKIE_SECURE must be true');
  });

  it('rejects a SameSite value the browser would not understand', () => {
    expect(validate({ COOKIE_SAMESITE: 'always' }).error).toBeDefined();
  });
});
