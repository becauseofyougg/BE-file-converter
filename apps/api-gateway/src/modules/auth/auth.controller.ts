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
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  AcceptedDto,
  ConfirmationRequiredDto,
  ErrorResponseDto,
  SessionResponseDto,
} from '../shared/api-responses.dto';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { TokenPair } from '@contracts/messages/identity.messages';
import { CORRELATION_ID_HEADER } from '@contracts/messaging/topology';
import { AppError } from '@core/errors/app-error';
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
import {
  REFRESH_TOKEN_COOKIE,
  SessionCookiesService,
  readCookie,
} from './session-cookies.service';

const HOUR_MS = 60 * 60 * 1000;

/** docs/REGISTRATION.md §10. */
const EmailLimit = (limit: number, ttlMs: number) =>
  SetMetadata(EMAIL_RATE_LIMIT, { limit, ttlMs });

@ApiTags('auth')
@ApiResponse({
  status: 400,
  description: 'A field failed validation.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 429,
  description: 'Rate limited — per IP, per email, or per account.',
  type: ErrorResponseDto,
})
@Controller('auth')
// Registration and confirmation are how a caller *gets* a token, so they
// cannot require one. The global JwtAuthGuard is opt-out for exactly this.
@Public()
@UseGuards(EmailRateLimitGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: SessionCookiesService,
  ) {}

  /**
   * `201` with a session when confirmation is off, `202` without one when it
   * is on. The status is the contract: a client can tell the two modes apart
   * without parsing the body, and `202` is literally what happened — the
   * request was accepted and the work is not finished.
   */
  @ApiOperation({
    summary: 'Create an account',
    description:
      'With `AUTH_CONFIRM_REGISTRATION` off, answers `201` and signs the user in. With it on, answers `202` and no session until the address is confirmed.',
  })
  @ApiResponse({
    status: 201,
    description: 'Registered and signed in; both tokens set as cookies.',
    type: SessionResponseDto,
  })
  @ApiResponse({
    status: 202,
    description: 'Registered; confirm the address to finish.',
    type: ConfirmationRequiredDto,
  })
  @ApiResponse({
    status: 409,
    description: 'The address is already registered.',
    type: ErrorResponseDto,
  })
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
        ...this.withSessionCookies(reply, result.tokens),
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
  @ApiOperation({
    summary: 'Sign in',
    description:
      'An unknown address and a wrong password are indistinguishable, including in how long they take. A locked account and an unconfirmed address are told plainly — see `docs/AUTHENTICATION.md` §3.',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed in; both tokens set as cookies.',
    type: SessionResponseDto,
  })
  @ApiResponse({
    status: 202,
    description: 'Confirmation required before a session is issued.',
    type: ConfirmationRequiredDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Unknown address or wrong password — deliberately the same.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'The address has never been confirmed.',
    type: ErrorResponseDto,
  })
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
        ...this.withSessionCookies(reply, result.tokens),
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
  @ApiOperation({
    summary: 'Complete a login waiting on a code or link',
    description:
      'The magic link points here. Accepts `challengeId` + `code`, or a bare `token`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed in.',
    type: SessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'The challenge is invalid, spent, or of the wrong type.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 410,
    description: 'The challenge expired.',
    type: ErrorResponseDto,
  })
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
      ...this.withSessionCookies(reply, result.tokens),
    };
  }

  /** Always `202`, whatever became of the challenge. */
  @ApiOperation({
    summary: 'Send another login confirmation',
    description:
      'Always `202`, whatever became of the challenge — the resend interval is enforced by identity-service.',
  })
  @ApiResponse({ status: 202, type: AcceptedDto })
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
  @ApiOperation({
    summary: 'Confirm an email address',
    description:
      'Signs the user in on success: they have already proved the password at registration and the address here.',
  })
  @ApiResponse({
    status: 200,
    description: 'Confirmed and signed in.',
    type: SessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'The challenge is invalid or spent.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 410,
    description: 'The challenge expired.',
    type: ErrorResponseDto,
  })
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
      ...this.withSessionCookies(reply, result.tokens),
    };
  }

  /**
   * Always `202`, whatever the state of the account — see
   * docs/REGISTRATION.md §5.4. The per-account interval is enforced by
   * identity-service, which is the only side that knows when the last mail
   * actually went out.
   */
  @ApiOperation({
    summary: 'Send another verification email',
    description:
      'Always `202`, whether the account exists, is already verified, or never existed.',
  })
  @ApiResponse({ status: 202, type: AcceptedDto })
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
   * Exchanges the refresh cookie for a new pair — docs/AUTHORIZATION.md §4.
   * Both cookies are replaced, since rotation is required and half a rotation
   * would leave the old refresh token live for another thirty days.
   *
   * `@Public()` by inheritance, and necessarily so: this is the endpoint a
   * client reaches for precisely *because* its access token has expired.
   */
  @ApiOperation({
    summary: 'Rotate the session',
    description:
      'Exchanges the `refresh_token` cookie for a whole new pair, and re-reads the roles — the one moment a revoked role takes effect.',
  })
  @ApiResponse({
    status: 200,
    description: 'Rotated; both cookies replaced.',
    type: SessionResponseDto,
  })
  @ApiResponse({
    status: 401,
    description:
      'No refresh cookie, or it is expired, forged or for an erased account.',
    type: ErrorResponseDto,
  })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // Roomy, because a legitimate client refreshes about four times an hour and
  // several tabs may each do it. It is still a ceiling on anyone replaying a
  // stolen token to keep a session alive indefinitely.
  @Throttle({ default: { limit: 60, ttl: HOUR_MS } })
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const refreshToken = readCookie(request, REFRESH_TOKEN_COOKIE);

    if (!refreshToken) {
      // Same answer as a rejected token. "You have no cookie" and "your cookie
      // is no good" lead a client to the same place: the login form.
      throw new AppError(
        ERROR_CODES.UNAUTHENTICATED,
        'The session has expired; sign in again',
        401,
      );
    }

    const result = await this.auth.refresh(
      refreshToken,
      callerContext(request),
    );

    return {
      status: result.status,
      userId: result.userId,
      ...this.withSessionCookies(reply, result.tokens),
    };
  }

  /**
   * Clears both cookies. That is the entirety of a logout here: with no
   * server-side record of a refresh token there is nothing to revoke, and the
   * tokens stay valid until they expire — docs/AUTHORIZATION.md §5.
   *
   * It answers `204` unconditionally, including when no session was there to
   * begin with, because a client's next move is the same either way.
   */
  @ApiOperation({
    summary: 'Clear the session cookies',
    description:
      'The whole of a logout here. Refresh tokens are not stored, so nothing can be revoked server-side — see docs/AUTHORIZATION.md §5.',
  })
  @ApiResponse({
    status: 204,
    description: 'Cookies cleared, whether or not a session existed.',
  })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) reply: FastifyReply): void {
    this.cookies.clear(reply);
  }

  /**
   * Both tokens go into httpOnly cookies and neither is returned in the body,
   * so no script on the page can read either one. The body carries only when
   * the access token dies, which is what a client needs in order to refresh
   * before a request fails rather than after.
   */
  private withSessionCookies(
    reply: FastifyReply,
    tokens: TokenPair,
  ): { accessTokenExpiresAt: string } {
    this.cookies.issue(reply, tokens);

    return { accessTokenExpiresAt: tokens.accessTokenExpiresAt };
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
