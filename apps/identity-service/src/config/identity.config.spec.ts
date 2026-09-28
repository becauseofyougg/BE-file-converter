import { identityConfigSchema } from './identity.config';

const VALID = {
  NODE_ENV: 'test',
  SERVICE_NAME: 'identity-service',
  PORT: 3001,
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/identity',
  RABBITMQ_URL: 'amqp://localhost:5672',
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
};

const validate = (overrides: Record<string, unknown> = {}) =>
  identityConfigSchema.validate({ ...VALID, ...overrides });

/**
 * The boot-time gate. Everything here fails the process rather than surfacing
 * as a runtime error at 3 a.m., which is the whole reason the schema exists.
 */
describe('identityConfigSchema', () => {
  it('accepts a minimal valid environment', () => {
    expect(validate().error).toBeUndefined();
  });

  describe('the signing keys', () => {
    /**
     * The gateway holds `JWT_SECRET` in order to verify every request. Sharing
     * one key would let a leaked gateway mint 30-day refresh tokens.
     */
    it('refuses to let the two secrets be the same', () => {
      const { error } = validate({ JWT_REFRESH_SECRET: VALID.JWT_SECRET });

      expect(error?.message).toContain('must differ');
    });

    it.each(['JWT_SECRET', 'JWT_REFRESH_SECRET'])(
      'refuses a short %s',
      (key) => {
        expect(validate({ [key]: 'too-short' }).error).toBeDefined();
      },
    );

    it.each(['JWT_SECRET', 'JWT_REFRESH_SECRET'])(
      'requires %s at all',
      (key) => {
        expect(validate({ [key]: undefined }).error).toBeDefined();
      },
    );
  });

  describe('defaults', () => {
    it('confirms registration but not login, out of the box', () => {
      const { value } = validate();

      expect(value.AUTH_CONFIRM_REGISTRATION).toBe(true);
      expect(value.AUTH_CONFIRM_LOGIN).toBe(false);
    });

    it('uses an OTP unless told otherwise', () => {
      expect(validate().value.AUTH_CONFIRM_METHOD).toBe('otp');
    });

    it('sets the documented lockout numbers', () => {
      const { value } = validate();

      expect(value.LOGIN_MAX_FAILED_ATTEMPTS).toBe(5);
      expect(value.LOGIN_LOCKOUT_MINUTES).toBe(15);
    });

    it('sets 15 minutes of access and 30 days of refresh', () => {
      const { value } = validate();

      expect(value.JWT_ACCESS_TTL).toBe('15m');
      expect(value.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    });
  });

  describe('closed sets', () => {
    it('refuses a confirmation method nobody implements', () => {
      expect(
        validate({ AUTH_CONFIRM_METHOD: 'carrier-pigeon' }).error,
      ).toBeDefined();
    });

    it('refuses a lockout that never locks', () => {
      expect(validate({ LOGIN_MAX_FAILED_ATTEMPTS: 0 }).error).toBeDefined();
    });
  });

  describe('the database url', () => {
    it('refuses a non-postgres scheme', () => {
      expect(
        validate({ DATABASE_URL: 'mysql://localhost/x' }).error,
      ).toBeDefined();
    });
  });

  describe('the broker url', () => {
    it('refuses a non-amqp scheme', () => {
      expect(
        validate({ RABBITMQ_URL: 'http://localhost' }).error,
      ).toBeDefined();
    });

    it('accepts amqps', () => {
      expect(
        validate({ RABBITMQ_URL: 'amqps://localhost:5671' }).error,
      ).toBeUndefined();
    });
  });
});
