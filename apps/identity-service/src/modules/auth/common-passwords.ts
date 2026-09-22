/**
 * Deny-list of passwords that are common enough to be tried first in any
 * credential-stuffing run.
 *
 * Deliberately small and inline: the policy's 12-character minimum already
 * excludes the overwhelming majority of the usual lists, and what survives it
 * is the handful of long-but-obvious strings below. Pulling in a full
 * ten-million-entry corpus would need a real store and a lookup budget to
 * match, for a marginal gain over length alone — worth revisiting if
 * registration ever sees real abuse.
 *
 * Entries are compared lower-cased.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password1234',
  'password12345',
  'password123456',
  'passw0rd1234',
  'qwertyuiop123',
  'qwerty1234567',
  '123456789012',
  '1234567890123',
  '112233445566',
  'iloveyou1234',
  'letmein12345',
  'welcome12345',
  'administrator',
  'adminadmin12',
  'football1234',
  'baseball1234',
  'superman1234',
  'trustno1many',
  'zaq12wsxcde3',
  '1qaz2wsx3edc',
  'qazwsxedcrfv',
  'asdfghjkl123',
  'zxcvbnm12345',
  'correcthorsebatterystaple',
  'thisisapassword',
  'passwordpassword',
  'changeme1234',
  'temporary123',
]);
