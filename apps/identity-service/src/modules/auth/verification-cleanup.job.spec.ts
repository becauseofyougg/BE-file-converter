import type { UsersService } from '../users/users.service';
import type { VerificationService } from './verification.service';
import {
  UNVERIFIED_RETENTION_DAYS,
  VerificationCleanupJob,
} from './verification-cleanup.job';

describe('VerificationCleanupJob', () => {
  let users: jest.Mocked<UsersService>;
  let verification: jest.Mocked<VerificationService>;
  let job: VerificationCleanupJob;

  beforeEach(() => {
    users = {
      deleteUnverifiedBefore: jest.fn().mockResolvedValue(2),
    } as unknown as jest.Mocked<UsersService>;

    verification = {
      deleteExpiredBefore: jest.fn().mockResolvedValue(5),
    } as unknown as jest.Mocked<VerificationService>;

    job = new VerificationCleanupJob(users, verification);
    jest.spyOn(job['logger'], 'log').mockImplementation(() => undefined);
  });

  /**
   * Without this a mistyped address holds an email hostage forever: the owner
   * of the real address can never register it, and the 409 they receive is not
   * something they can resolve themselves.
   */
  it('removes unverified accounts older than the retention window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-31T00:00:00.000Z'));

    await job.run();

    expect(users.deleteUnverifiedBefore).toHaveBeenCalledWith(
      new Date('2026-01-24T00:00:00.000Z'),
    );

    jest.useRealTimers();
  });

  it('keeps an account younger than the window', () => {
    // Seven days is the contract the message to the user is written against.
    expect(UNVERIFIED_RETENTION_DAYS).toBe(7);
  });

  it('removes every token already past its expiry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-31T00:00:00.000Z'));

    await job.run();

    expect(verification.deleteExpiredBefore).toHaveBeenCalledWith(
      new Date('2026-01-31T00:00:00.000Z'),
    );

    jest.useRealTimers();
  });

  it('reports what it removed, so a silent no-op is visible', async () => {
    const logger = jest.spyOn(job['logger'], 'log');

    await job.run();

    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.verification.cleanup',
        unverifiedUsersRemoved: 2,
        expiredTokensRemoved: 5,
      }),
    );
  });

  it('lets a failure surface rather than logging a false success', async () => {
    users.deleteUnverifiedBefore.mockRejectedValue(new Error('database gone'));

    await expect(job.run()).rejects.toThrow('database gone');
  });
});
