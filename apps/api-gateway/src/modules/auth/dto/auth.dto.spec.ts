import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { LoginDto } from './auth.dto';

const errorsFor = (body: object) =>
  validateSync(plainToInstance(LoginDto, body)).map((error) => error.property);

describe('LoginDto', () => {
  it('accepts an email and any non-empty password', () => {
    expect(errorsFor({ email: 'ada@example.com', password: 'x' })).toEqual([]);
  });

  /**
   * No minimum length — a short password is still a guess worth checking —
   * but an empty one is a missing field, and letting it through would count
   * towards the lockout as a wrong guess.
   */
  it('refuses an empty password', () => {
    expect(errorsFor({ email: 'ada@example.com', password: '' })).toEqual([
      'password',
    ]);
  });

  it('refuses a missing password', () => {
    expect(errorsFor({ email: 'ada@example.com' })).toEqual(['password']);
  });

  it('refuses a malformed email', () => {
    expect(errorsFor({ email: 'not-an-email', password: 'x' })).toEqual([
      'email',
    ]);
  });
});
