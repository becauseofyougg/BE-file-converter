import { ConfigService } from './config.service';

interface TestConfig {
  PORT: number;
  SERVICE_NAME: string;
  HEALTH_CHECK_ENABLED: boolean;
  MISSING: string;
}

/**
 * Built directly rather than through the testing module: `ConfigService`
 * *extends* Nest's, so a provider override would leave the real parent in
 * place and the stub unused. The parent reads from the object it is
 * constructed with, which is exactly the seam a test wants.
 */
describe('ConfigService', () => {
  async function build(
    values: Partial<Record<keyof TestConfig, unknown>>,
  ): Promise<ConfigService<TestConfig>> {
    return Promise.resolve(
      new ConfigService<TestConfig>(values as Record<string, unknown>),
    );
  }

  it('is defined', async () => {
    await expect(build({})).resolves.toBeDefined();
  });

  describe('get', () => {
    it('returns the value', async () => {
      const config = await build({ SERVICE_NAME: 'api-gateway' });

      expect(config.get('SERVICE_NAME')).toBe('api-gateway');
    });
  });

  describe('getNumber', () => {
    it('coerces a numeric string, which is how a raw env arrives', async () => {
      const config = await build({ PORT: '3000' });

      expect(config.getNumber('PORT')).toBe(3000);
    });

    it('passes a number Joi already coerced straight through', async () => {
      const config = await build({ PORT: 3000 });

      expect(config.getNumber('PORT')).toBe(3000);
    });
  });

  describe('getBoolean', () => {
    /**
     * Joi coerces `"true"` into `true` when the schema declares a boolean, but
     * an unvalidated variable arrives as a raw string — both have to work.
     */
    it.each([
      [true, true],
      ['true', true],
      ['TRUE', true],
      ['True', true],
      [false, false],
      ['false', false],
      ['anything else', false],
      [undefined, false],
    ])('reads %j as %s', async (value, expected) => {
      const config = await build({ HEALTH_CHECK_ENABLED: value });

      expect(config.getBoolean('HEALTH_CHECK_ENABLED')).toBe(expected);
    });

    /**
     * Not truthy-coerced: a bare `1` in the environment is far more likely to
     * be a typo than an intent to switch something on.
     */
    it('does not treat 1 as true', async () => {
      const config = await build({ HEALTH_CHECK_ENABLED: 1 });

      expect(config.getBoolean('HEALTH_CHECK_ENABLED')).toBe(false);
    });
  });
});
