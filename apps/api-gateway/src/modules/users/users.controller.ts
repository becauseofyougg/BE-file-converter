import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type {
  ConfirmEmailChangeResponse,
  DeleteUserResponse,
  StartEmailChangeResponse,
  UserProfile,
} from '@contracts/messages/users.messages';
import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';
import { CurrentUser, Public, type RequestUser } from '../auth/jwt-auth.guard';
import { SessionCookiesService } from '../auth/session-cookies.service';
import {
  ConfirmDeletionDto,
  ConfirmEmailChangeDto,
  DeleteUserDto,
  StartEmailChangeDto,
  UpdateUserDto,
} from './dto/update-user.dto';
import { UserParamsDto } from './dto/user-params.dto';
import {
  PROFILE_READ_RATE_LIMIT,
  ProfileReadRateLimitGuard,
  type ProfileReadRateLimit,
} from './profile-read-rate-limit.guard';
import { UsersService } from './users.service';

const HOUR_MS = 60 * 60 * 1000;

const ProfileReadLimit = (limit: number, ttlMs: number) =>
  SetMetadata(PROFILE_READ_RATE_LIMIT, {
    limit,
    ttlMs,
  } satisfies ProfileReadRateLimit);

@Controller('users')
@UseGuards(ProfileReadRateLimitGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly cookies: SessionCookiesService,
  ) {}

  /**
   * docs/USER-PROFILE.md.
   *
   * Not `@Public()`, and deliberately not `@Permissions('users@read')` either.
   * The rule is "self **or** `users@read`", which depends on who the target
   * turns out to be — a route decorator sees the caller and the URL but cannot
   * weigh one against the other, and gating the route on the permission would
   * refuse a user their own profile. Identity decides, because it holds both
   * the target row and the RBAC config (§3).
   *
   * Two limits, measuring different things: 300/hour per IP for the route, and
   * 60/hour per *viewer* for reads of someone else's profile.
   */
  @Get(':userId')
  @Throttle({ default: { limit: 300, ttl: HOUR_MS } })
  @ProfileReadLimit(60, HOUR_MS)
  getProfile(
    @Param() params: UserParamsDto,
    @CurrentUser() viewer: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<UserProfile> {
    return this.users.getProfile({
      targetUserId: params.userId,
      // From the verified token, never from the URL or the body — this is the
      // whole of the IDOR defence in §1.6.
      viewerUserId: viewer.id,
      viewerRoles: viewer.roles,
      correlationId: correlationId(request),
    });
  }

  /**
   * docs/PROFILE-UPDATE.md §3. Self, or the holder of `users@update` — decided
   * in identity for the same reason the read is, and with its own permission so
   * a role can be given sight of a profile without the power to change it.
   *
   * A field this caller may not write is **refused**, not dropped. Silently
   * ignoring it would leave the client believing a change it can see in its own
   * form actually happened.
   */
  @Patch(':userId')
  @Throttle({ default: { limit: 60, ttl: HOUR_MS } })
  @ProfileReadLimit(60, HOUR_MS)
  updateProfile(
    @Param() params: UserParamsDto,
    @Body() patch: UpdateUserDto,
    @CurrentUser() viewer: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<UserProfile> {
    return this.users.updateProfile({
      targetUserId: params.userId,
      viewerUserId: viewer.id,
      viewerRoles: viewer.roles,
      patch,
      correlationId: correlationId(request),
    });
  }

  /**
   * §4. Self only — there is no permission that opens this to anyone else,
   * because an administrator has the direct path and does not need to
   * impersonate a confirmation.
   *
   * Tighter than the rest: this one sends mail to an address the caller chose,
   * so the per-IP ceiling is what stops it being used to post letters.
   */
  @Post(':userId/email-change')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: HOUR_MS } })
  startEmailChange(
    @Param() params: UserParamsDto,
    @Body() dto: StartEmailChangeDto,
    @CurrentUser() viewer: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<StartEmailChangeResponse> {
    return this.users.startEmailChange({
      targetUserId: params.userId,
      viewerUserId: viewer.id,
      newEmail: dto.newEmail,
      correlationId: correlationId(request),
    });
  }

  /**
   * §4.2, and `@Public()` deliberately: the link is opened in the *new* mailbox,
   * usually on another device that has no session. What authorises the change
   * is the secret — which only the holder of that mailbox received, and which
   * an authenticated Self had to ask for in the first place. Requiring a
   * session here would break the ordinary case without adding a factor the
   * initiating request had not already supplied.
   */
  @Post(':userId/email-change/confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: HOUR_MS } })
  confirmEmailChange(
    @Param() params: UserParamsDto,
    @Body() dto: ConfirmEmailChangeDto,
    @Req() request: FastifyRequest,
  ): Promise<ConfirmEmailChangeResponse> {
    return this.users.confirmEmailChange({
      targetUserId: params.userId,
      challengeId: dto.challengeId,
      code: dto.code,
      token: dto.token,
      correlationId: correlationId(request),
    });
  }

  /**
   * docs/ACCOUNT-DELETION.md. `DELETE` rather than `POST …/delete`, which
   * §1.3.1 left open: the method already means this, and an idempotent verb
   * matches an operation whose second call is a no-op.
   *
   * Two outcomes. An administrator holding `users@delete` gets `204` and it is
   * done; a user erasing their own account gets `202` and a challenge, because
   * this is the one irreversible thing the API does and a session found on an
   * unlocked laptop should not be enough to do it.
   */
  @Delete(':userId')
  @Throttle({ default: { limit: 5, ttl: HOUR_MS } })
  @ProfileReadLimit(10, HOUR_MS)
  async deleteUser(
    @Param() params: UserParamsDto,
    @Body() dto: DeleteUserDto,
    @CurrentUser() viewer: RequestUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DeleteUserResponse | undefined> {
    const result = await this.users.deleteUser({
      targetUserId: params.userId,
      viewerUserId: viewer.id,
      viewerRoles: viewer.roles,
      reason: dto.reason,
      correlationId: correlationId(request),
    });

    if (result.status === 'confirmation_required') {
      void reply.status(HttpStatus.ACCEPTED);

      return result;
    }

    this.endSessionIfSelf(reply, viewer, params.userId);
    void reply.status(HttpStatus.NO_CONTENT);

    return undefined;
  }

  /**
   * Completes a self-erasure. **Authenticated**, unlike the email-change
   * confirmation — the contrast is deliberate. That link goes to a mailbox the
   * user has not proved yet, often on a second device with no session; this one
   * goes to their own address, on the device they are already signed in on, and
   * destroys the account. Requiring both the session and the secret costs
   * nothing here and means an intercepted mail is not enough on its own.
   */
  @Post(':userId/deletion/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: HOUR_MS } })
  async confirmDeletion(
    @Param() params: UserParamsDto,
    @Body() dto: ConfirmDeletionDto,
    @CurrentUser() viewer: RequestUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.users.confirmDeletion({
      targetUserId: params.userId,
      viewerUserId: viewer.id,
      challengeId: dto.challengeId,
      code: dto.code,
      token: dto.token,
      correlationId: correlationId(request),
    });

    this.endSessionIfSelf(reply, viewer, params.userId);
  }

  /**
   * Clears the cookies of somebody who has just erased their own account, so
   * the browser stops sending credentials for a user that no longer exists.
   *
   * It is a courtesy, not the security boundary: the tokens stay
   * cryptographically valid, and what actually ends the session is identity
   * refusing to refresh a deleted account — at most one access-token lifetime
   * later (docs/ACCOUNT-DELETION.md §6).
   */
  private endSessionIfSelf(
    reply: FastifyReply,
    viewer: RequestUser,
    targetUserId: string,
  ): void {
    if (viewer.id === targetUserId) {
      this.cookies.clear(reply);
    }
  }
}

function correlationId(request: FastifyRequest): string {
  return (
    (request.headers[CORRELATION_ID_HEADER] as string | undefined) ??
    String(request.id ?? randomUUID())
  );
}
