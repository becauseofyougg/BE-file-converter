import type { ConfigService } from '@core/config/config.service';

import { AuthSettingsService } from './auth-settings.service';

describe('AuthSettingsService', () => {
  function build(values: Record<string, unknown>) {
    return new AuthSettingsService({
      get: (key: string) => values[key] as string,
      getBoolean: (key: string) =>
        values[key] === true || String(values[key]).toLowerCase() === 'true',
      getNumber: (key: string) => Number(values[key]),
    } as unknown as ConfigService<never>);
  }

  /**
   * Every caller reads these through the service, so swapping the environment
   * for a cached settings table later changes one provider and no call sites.
   */
  describe('the administrator switches', () => {
    it.each([
      ['confirmRegistration', 'AUTH_CONFIRM_REGISTRATION'],
      ['confirmPasswordReset', 'AUTH_CONFIRM_PASSWORD_RESET'],
      ['confirmLogin', 'AUTH_CONFIRM_LOGIN'],
    ])('%s reads %s', (method, key) => {
      expect(build({ [key]: true })[method as 'confirmLogin']()).toBe(true);
      expect(build({ [key]: false })[method as 'confirmLogin']()).toBe(false);
    });

    it('accepts the string form an unvalidated variable arrives as', () => {
      expect(build({ AUTH_CONFIRM_LOGIN: 'true' }).confirmLogin()).toBe(true);
    });
  });

  describe('confirmationMethod', () => {
    it('is a link only when it says link', () => {
      expect(build({ AUTH_CONFIRM_METHOD: 'link' }).confirmationMethod()).toBe(
        'link',
      );
    });

    /** Anything unrecognised falls back to the weaker-to-intercept option. */
    it.each([['otp'], ['nonsense'], [undefined]])(
      'is an OTP for %s',
      (value) => {
        expect(build({ AUTH_CONFIRM_METHOD: value }).confirmationMethod()).toBe(
          'otp',
        );
      },
    );
  });

  describe('the lockout numbers', () => {
    it('reads the attempt cap as given', () => {
      expect(
        build({ LOGIN_MAX_FAILED_ATTEMPTS: 5 }).maxFailedLoginAttempts(),
      ).toBe(5);
    });

    /** Configured in minutes, used in milliseconds. */
    it('converts the lockout from minutes to milliseconds', () => {
      expect(build({ LOGIN_LOCKOUT_MINUTES: 15 }).loginLockoutMs()).toBe(
        900_000,
      );
    });
  });
});
