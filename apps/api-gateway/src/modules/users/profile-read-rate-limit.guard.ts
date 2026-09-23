import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard';

export interface ProfileReadRateLimit {
  limit: number;
  ttlMs: number;
}

export const PROFILE_READ_RATE_LIMIT = 'PROFILE_READ_RATE_LIMIT';

/**
 * Rate-limits reading *other people's* profiles, keyed on the viewer —
 * docs/USER-PROFILE.md §1.4, which asks for a limit "especially for viewing
 * others".
 *
 * Per viewer rather than per IP, because the account is what holds the
 * permission: someone with `users@read` who starts walking the user table does
 * so from wherever they like, and the per-IP throttle only counts connections.
 *
 * Self-reads are exempt. A client polling its own profile is ordinary
 * behaviour, it reveals nothing about anyone else, and counting it would let a
 * busy tab lock its own user out of a support call.
 */
@Injectable()
export class ProfileReadRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(ProfileReadRateLimitGuard.name);

  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<ProfileReadRateLimit>(
      PROFILE_READ_RATE_LIMIT,
      [context.getHandler(), context.getClass()],
    );

    if (!config) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const viewerId = request.user?.id;
    const targetId = (request.params as { userId?: string } | undefined)
      ?.userId;

    // No caller yet, or nothing to compare: the JWT guard and the DTO both run
    // regardless, so there is nothing useful to count here.
    if (!viewerId || !targetId || viewerId === targetId) {
      return true;
    }

    const record = await this.storage.increment(
      `profile-read:${viewerId}`,
      Math.ceil(config.ttlMs / 1000),
      config.limit,
      0,
      'profile-read',
    );

    if (record.totalHits > config.limit) {
      this.logger.warn({
        event: 'users.profile.rate_limited',
        dimension: 'viewer',
        viewerUserId: viewerId,
      });

      throw new AppError(
        ERROR_CODES.RATE_LIMITED,
        'Too many profile lookups, please try again later',
        429,
        { retryAfterSeconds: record.timeToExpire },
      );
    }

    return true;
  }
}
