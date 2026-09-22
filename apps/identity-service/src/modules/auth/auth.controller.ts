import { randomUUID } from 'node:crypto';

import { Controller, UseFilters, ValidationPipe } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';

import {
  IDENTITY_PATTERNS,
  type ConfirmLoginResponse,
  type LoginResponse,
  type RefreshResponse,
  type RegisterResponse,
  type ResendVerificationResponse,
  type VerifyEmailResponse,
} from '@contracts/messages/identity.messages';
import { RpcAppExceptionFilter } from '@core/errors/rpc-app-exception.filter';
import { settleRpc } from '@core/messaging/rmq-ack';
import { AuthService } from './auth.service';
import {
  ConfirmLoginMessageDto,
  LoginMessageDto,
  ResendLoginConfirmationMessageDto,
} from './dto/login.dto';
import { LoginService } from './login.service';
import { RefreshService } from './refresh.service';
import { RefreshMessageDto } from './dto/refresh.dto';
import { RegisterMessageDto } from './dto/register.dto';
import {
  ResendVerificationMessageDto,
  VerifyEmailMessageDto,
} from './dto/verify-email.dto';

/**
 * Mirrors the gateway's global pipe, since this boundary is validated
 * independently of it.
 */
const messageValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

/**
 * The RPC surface of registration. Every handler acks manually: the message is
 * only removed from the queue once the transaction has committed, so a crash
 * mid-registration redelivers rather than losing the request.
 *
 * A business refusal is still a completed handling — the reply carries the
 * error code and the message is acked. Requeuing it would retry a request that
 * will fail identically forever.
 */
@Controller()
@UseFilters(RpcAppExceptionFilter)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly login: LoginService,
    private readonly refreshService: RefreshService,
  ) {}

  @MessagePattern(IDENTITY_PATTERNS.REGISTER)
  async register(
    @Payload(messageValidationPipe) dto: RegisterMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<RegisterResponse> {
    return settleRpc(context, () =>
      this.auth.register({
        email: dto.email,
        password: dto.password,
        correlationId: dto.correlationId ?? randomUUID(),
        session: { userAgent: dto.userAgent, ip: dto.ip },
      }),
    );
  }

  @MessagePattern(IDENTITY_PATTERNS.VERIFY_EMAIL)
  async verifyEmail(
    @Payload(messageValidationPipe) dto: VerifyEmailMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<VerifyEmailResponse> {
    return settleRpc(context, () =>
      this.auth.verifyEmail({
        challengeId: dto.challengeId,
        code: dto.code,
        token: dto.token,
        correlationId: dto.correlationId ?? randomUUID(),
        session: { userAgent: dto.userAgent, ip: dto.ip },
      }),
    );
  }

  @MessagePattern(IDENTITY_PATTERNS.RESEND_VERIFICATION)
  async resendVerification(
    @Payload(messageValidationPipe) dto: ResendVerificationMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<ResendVerificationResponse> {
    return settleRpc(context, () =>
      this.auth.resendVerification({
        challengeId: dto.challengeId,
        email: dto.email,
        correlationId: dto.correlationId ?? randomUUID(),
      }),
    );
  }
  @MessagePattern(IDENTITY_PATTERNS.LOGIN)
  async logIn(
    @Payload(messageValidationPipe) dto: LoginMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<LoginResponse> {
    return settleRpc(context, () =>
      this.login.login({
        email: dto.email,
        password: dto.password,
        correlationId: dto.correlationId ?? randomUUID(),
        session: { userAgent: dto.userAgent, ip: dto.ip },
      }),
    );
  }

  @MessagePattern(IDENTITY_PATTERNS.CONFIRM_LOGIN)
  async confirmLogin(
    @Payload(messageValidationPipe) dto: ConfirmLoginMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<ConfirmLoginResponse> {
    return settleRpc(context, () =>
      this.login.confirmLogin({
        challengeId: dto.challengeId,
        code: dto.code,
        token: dto.token,
        correlationId: dto.correlationId ?? randomUUID(),
        session: { userAgent: dto.userAgent, ip: dto.ip },
      }),
    );
  }

  /**
   * No `@Transactional()` and no outbox: refreshing writes nothing. It reads
   * the account, re-reads its roles and signs two tokens — there is no
   * server-side session to update, because docs/AUTHORIZATION.md §1 forbids
   * one existing.
   */
  @MessagePattern(IDENTITY_PATTERNS.REFRESH)
  async refresh(
    @Payload(messageValidationPipe) dto: RefreshMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<RefreshResponse> {
    return settleRpc(context, () =>
      this.refreshService.refresh({
        refreshToken: dto.refreshToken,
        correlationId: dto.correlationId ?? randomUUID(),
      }),
    );
  }

  @MessagePattern(IDENTITY_PATTERNS.RESEND_LOGIN_CONFIRMATION)
  async resendLoginConfirmation(
    @Payload(messageValidationPipe) dto: ResendLoginConfirmationMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<{ status: 'accepted' }> {
    return settleRpc(context, () =>
      this.login.resendConfirmation(
        dto.challengeId,
        dto.correlationId ?? randomUUID(),
      ),
    );
  }
}
