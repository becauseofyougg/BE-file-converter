import { randomUUID } from 'node:crypto';

import {
  Controller,
  Get,
  Param,
  Req,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

import type { UserProfile } from '@contracts/messages/users.messages';
import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';
import { CurrentUser, type RequestUser } from '../auth/jwt-auth.guard';
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
  constructor(private readonly users: UsersService) {}

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
      correlationId:
        (request.headers[CORRELATION_ID_HEADER] as string | undefined) ??
        String(request.id ?? randomUUID()),
    });
  }
}
