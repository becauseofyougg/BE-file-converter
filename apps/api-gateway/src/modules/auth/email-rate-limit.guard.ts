import { createHash } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import { FastifyRequest } from 'fastify';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';

export interface EmailRateLimit {
  limit: number;
  ttlMs: number;
}

export const EMAIL_RATE_LIMIT = 'EMAIL_RATE_LIMIT';

/**
 * Rate-limits by the submitted email, on top of the per-IP throttle.
 *
 * The two defend against different attacks and neither substitutes for the
 * other: a per-IP limit does nothing against a botnet hammering one address,
 * and a per-email limit does nothing against one host enumerating thousands.
 * `ThrottlerGuard` tracks a single dimension per route, hence a second guard
 * rather than a configuration flag.
 *
 * The address is hashed into the key so a store dump — or a Redis `KEYS` scan
 * once the storage is shared — is not a list of who has been registering.
 */
@Injectable()
export class EmailRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(EmailRateLimitGuard.name);

  constructor(
    @Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.getAllAndOverride<EmailRateLimit>(
      EMAIL_RATE_LIMIT,
      [context.getHandler(), context.getClass()],
    );

    if (!config) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const email = (request.body as { email?: unknown } | undefined)?.email;

    // Nothing to key on — the per-IP throttle and the DTO still apply.
    if (typeof email !== 'string' || email.length === 0) {
      return true;
    }

    const key = `email:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;

    const record = await this.storage.increment(
      key,
      Math.ceil(config.ttlMs / 1000),
      config.limit,
      0,
      'email',
    );

    if (record.totalHits > config.limit) {
      this.logger.warn({
        event: 'auth.rate_limited',
        dimension: 'email',
        route: request.url,
      });

      throw new AppError(
        ERROR_CODES.RATE_LIMITED,
        'Too many attempts for this email address, please try again later',
        429,
        { retryAfterSeconds: record.timeToExpire },
      );
    }

    return true;
  }
}
