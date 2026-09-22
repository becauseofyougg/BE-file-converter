import { Injectable, Logger } from '@nestjs/common';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { RefreshResponse } from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import { UserRolesService } from '../rbac/user-roles.service';
import { TokensService } from '../tokens/tokens.service';
import { UsersService, isEmailVerified } from '../users/users.service';

export interface RefreshInput {
  refreshToken: string;
  correlationId: string;
}

/**
 * Trades a live refresh token for a new pair — docs/AUTHORIZATION.md §4.
 *
 * This is the only moment in a session's life when the database is consulted
 * about the account, so it is also the only moment a change to that account can
 * take effect. Without a stored refresh token there is nothing to revoke, which
 * makes the roles read here the single lever left: a role taken away reaches
 * the user on their next refresh, at most one access-token lifetime later,
 * rather than in thirty days.
 */
@Injectable()
export class RefreshService {
  private readonly logger = new Logger(RefreshService.name);

  constructor(
    private readonly users: UsersService,
    private readonly tokens: TokensService,
    private readonly userRoles: UserRolesService,
  ) {}

  async refresh(input: RefreshInput): Promise<RefreshResponse> {
    const claims = await this.tokens.verifyRefresh(input.refreshToken);

    const user = await this.users.findById(claims.sub);

    // §1.3.1 steps 3–4: resolve the subject and check the account is still one
    // that may hold a session. A user deleted since the token was signed still
    // holds a perfectly valid signature, and the signature is all the token is.
    if (!user || !isEmailVerified(user)) {
      this.logger.warn({
        event: 'auth.refresh.rejected',
        reason: user ? 'email_not_verified' : 'unknown_subject',
        userId: claims.sub,
      });

      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'The session has expired; sign in again',
        401,
      );
    }

    // A login lockout is deliberately *not* a barrier here. It exists to stop
    // password guessing, and the holder of this token guessed nothing — letting
    // it block a refresh would hand anyone a way to knock an account's live
    // sessions offline by failing five logins against it.
    const roles = await this.userRoles.namesFor(user.id);

    this.logger.log({
      event: 'auth.refresh.succeeded',
      userId: user.id,
      roles,
    });

    return {
      status: 'refreshed',
      userId: user.id,
      // A whole new pair, not just an access token: rotation is required, and
      // the alternative leaves one long-lived token in play for thirty days
      // with no way to notice it has been copied.
      tokens: await this.tokens.issuePair(user, roles),
    };
  }
}
