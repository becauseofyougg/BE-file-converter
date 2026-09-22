import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { TokenPair } from '@contracts/messages/identity.messages';
import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';
import { AuthService, type CallerContext } from './auth.service';
import {
  ConfirmLoginDto,
  LoginDto,
  RegisterDto,
  ResendLoginConfirmationDto,
  ResendVerificationDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import {
  EMAIL_RATE_LIMIT,
  EmailRateLimitGuard,
} from './email-rate-limit.guard';
import { Public } from './jwt-auth.guard';

const HOUR_MS = 60 * 60 * 1000;

/** docs/REGISTRATION.md §10. */
const EmailLimit = (limit: number, ttlMs: number) =>
  SetMetadata(EMAIL_RATE_LIMIT, { limit, ttlMs });

@Controller('auth')
// Registration and confirmation are how a caller *gets* a token, so they
// cannot require one. The global JwtAuthGuard is opt-out for exactly this.
@Public()
@UseGuards(EmailRateLimitGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * `201` with a session when confirmation is off, `202` without one when it
   * is on. The status is the contract: a client can tell the two modes apart
   * without parsing the body, and `202` is literally what happened — the
   * request was accepted and the work is not finished.
   */
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: HOUR_MS } })
  @EmailLimit(3, HOUR_MS)
  async register(
    @Body() dto: RegisterDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.register(
      { email: dto.email, password: dto.password },
      callerContext(request),
    );

    if (result.status === 'registered' && result.tokens) {
      void reply.status(HttpStatus.CREATED);

      return {
        status: result.status,
        userId: result.userId,
        ...this.withRefreshCookie(reply, result.tokens),
      };
    }

    void reply.status(HttpStatus.ACCEPTED);

    return {
      status: 'confirmation_required',
      challengeId: result.challengeId,
      expiresAt: result.expiresAt,
    };
  }

  /**
   * `200` with a session when login confirmation is off, `202` without one
   * when it is on — the same shape registration uses, for the same reason.
   *
   * The per-email limit is tighter than registration's: this is the endpoint a
   * password-spraying botnet aims at, and the per-IP throttle does nothing
   * against one that rotates addresses.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: HOUR_MS } })
  @EmailLimit(5, 15 * 60 * 1000)
  async login(
    @Body() dto: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.login(
      { email: dto.email, password: dto.password },
      callerContext(request),
    );

    if (result.status === 'authenticated' && result.tokens) {
      return {
        status: result.status,
        userId: result.userId,
        ...this.withRefreshCookie(reply, result.tokens),
      };
    }

    void reply.status(HttpStatus.ACCEPTED);

    return {
      status: 'confirmation_required',
      challengeId: result.challengeId,
      expiresAt: result.expiresAt,
    };
  }

  /**
   * Completes a login that was waiting on an emailed code or link. The magic
   * link points here — docs/AUTHENTICATION.md §1.3.2.
   */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: HOUR_MS } })
  async confirmLogin(
    @Body() dto: ConfirmLoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.confirmLogin(
      { challengeId: dto.challengeId, code: dto.code, token: dto.token },
      callerContext(request),
    );

    return {
      status: result.status,
      userId: result.userId,
      ...this.withRefreshCookie(reply, result.tokens),
    };
  }

  /** Always `202`, whatever became of the challenge. */
  @Post('resend-login-confirmation')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: HOUR_MS } })
  async resendLoginConfirmation(
    @Body() dto: ResendLoginConfirmationDto,
    @Req() request: FastifyRequest,
  ) {
    return this.auth.resendLoginConfirmation(
      dto.challengeId,
      callerContext(request),
    );
  }

  /**
   * Confirming signs the user in: they have just proved the password (at
   * registration) and the address, so a second login round trip earns nothing.
   */
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: HOUR_MS } })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.auth.verifyEmail(
      { challengeId: dto.challengeId, code: dto.code, token: dto.token },
      callerContext(request),
    );

    return {
      status: result.status,
      userId: result.userId,
      ...this.withRefreshCookie(reply, result.tokens),
    };
  }

  /**
   * Always `202`, whatever the state of the account — see
   * docs/REGISTRATION.md §5.4. The per-account interval is enforced by
   * identity-service, which is the only side that knows when the last mail
   * actually went out.
   */
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 10, ttl: HOUR_MS } })
  @EmailLimit(5, HOUR_MS)
  async resendVerification(
    @Body() dto: ResendVerificationDto,
    @Req() request: FastifyRequest,
  ) {
    return this.auth.resendVerification(
      { challengeId: dto.challengeId, email: dto.email },
      callerContext(request),
    );
  }

  /**
   * The refresh token goes in an httpOnly cookie and never into the body, so
   * no script on the page can read it; the access token goes in the body,
   * because it is meant to be read and attached to requests. `SameSite=Strict`
   * is what keeps the cookie from riding along on a cross-site request.
   */
  private withRefreshCookie(
    reply: FastifyReply,
    tokens: TokenPair,
  ): { accessToken: string; accessTokenExpiresAt: string } {
    void reply.setCookie('refresh_token', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/auth',
      signed: true,
    });

    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    };
  }
}

function callerContext(request: FastifyRequest): CallerContext {
  return {
    correlationId:
      (request.headers[CORRELATION_ID_HEADER] as string | undefined) ??
      String(request.id ?? randomUUID()),
    userAgent: request.headers['user-agent'],
    ip: request.ip,
  };
}
