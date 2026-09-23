import { ERROR_CODES } from '@contracts/errors/error-codes';
import { REFRESH_TOKEN_TYPE } from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import { UserRolesService } from '../rbac/user-roles.service';
import { TokensService } from '../tokens/tokens.service';
import { UsersService, type User } from '../users/users.service';
import { RefreshService } from './refresh.service';

const CORRELATION_ID = 'correlation-1';

function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: '$argon2id$stub',
    emailVerifiedAt: new Date(),
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

describe('RefreshService', () => {
  let users: jest.Mocked<UsersService>;
  let tokens: jest.Mocked<TokensService>;
  let userRoles: jest.Mocked<UserRolesService>;
  let service: RefreshService;

  beforeEach(() => {
    users = {
      findById: jest.fn().mockResolvedValue(buildUser()),
    } as unknown as jest.Mocked<UsersService>;

    tokens = {
      verifyRefresh: jest.fn().mockResolvedValue({
        sub: 'user-1',
        jti: 'jti-1',
        typ: REFRESH_TOKEN_TYPE,
      }),
      issuePair: jest.fn().mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: new Date().toISOString(),
        refreshTokenExpiresAt: new Date().toISOString(),
      }),
    } as unknown as jest.Mocked<TokensService>;

    userRoles = {
      namesFor: jest.fn().mockResolvedValue(['USER']),
    } as unknown as jest.Mocked<UserRolesService>;

    service = new RefreshService(users, tokens, userRoles);
  });

  const refresh = (refreshToken = 'a.b.c') =>
    service.refresh({ refreshToken, correlationId: CORRELATION_ID });

  it('returns a whole new pair, not just an access token', async () => {
    const result = await service.refresh({
      refreshToken: 'a.b.c',
      correlationId: CORRELATION_ID,
    });

    expect(result.status).toBe('refreshed');
    expect(result.tokens.accessToken).toBe('access');
    expect(result.tokens.refreshToken).toBe('refresh');
  });

  /**
   * The whole reason refreshing goes through identity rather than being signed
   * at the gateway: it is the one moment a revoked role can take effect, since
   * nothing else about a session is ever re-read.
   */
  it('re-reads the roles rather than copying them from the old token', async () => {
    userRoles.namesFor.mockResolvedValue(['USER', 'ADMIN']);

    await refresh();

    expect(userRoles.namesFor).toHaveBeenCalledWith('user-1');
    expect(tokens.issuePair).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      ['USER', 'ADMIN'],
    );
  });

  it('refuses a token whose subject no longer exists', async () => {
    users.findById.mockResolvedValue(null);

    await expect(refresh()).rejects.toThrow(
      expect.objectContaining({ code: ERROR_CODES.UNAUTHENTICATED }),
    );
    expect(tokens.issuePair).not.toHaveBeenCalled();
  });

  it('refuses an account whose address is no longer confirmed', async () => {
    users.findById.mockResolvedValue(buildUser({ emailVerifiedAt: null }));

    await expect(refresh()).rejects.toThrow(AppError);
    expect(tokens.issuePair).not.toHaveBeenCalled();
  });

  /**
   * Otherwise five failed logins against someone else's address would knock
   * their live sessions offline — a denial of service handed to anyone who
   * knows an email.
   */
  it('lets a locked-out account refresh an existing session', async () => {
    users.findById.mockResolvedValue(
      buildUser({
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 900_000),
      }),
    );

    await expect(refresh()).resolves.toMatchObject({ status: 'refreshed' });
  });

  it('issues nothing when the token does not verify', async () => {
    tokens.verifyRefresh.mockRejectedValue(
      new AppError(ERROR_CODES.UNAUTHENTICATED, 'nope', 401),
    );

    await expect(refresh()).rejects.toThrow(AppError);
    expect(users.findById).not.toHaveBeenCalled();
    expect(tokens.issuePair).not.toHaveBeenCalled();
  });
});
