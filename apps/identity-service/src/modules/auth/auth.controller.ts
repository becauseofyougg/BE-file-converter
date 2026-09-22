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
  type RegisterResponse,
  type ResendVerificationResponse,
  type VerifyEmailResponse,
} from '@contracts/messages/identity.messages';
import { AppError } from '@core/errors/app-error';
import { RpcAppExceptionFilter } from '@core/errors/rpc-app-exception.filter';
import { AuthService } from './auth.service';
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
  constructor(private readonly auth: AuthService) {}

  @MessagePattern(IDENTITY_PATTERNS.REGISTER)
  async register(
    @Payload(messageValidationPipe) dto: RegisterMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<RegisterResponse> {
    return this.settle(context, () =>
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
    return this.settle(context, () =>
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
    return this.settle(context, () =>
      this.auth.resendVerification({
        challengeId: dto.challengeId,
        email: dto.email,
        correlationId: dto.correlationId ?? randomUUID(),
      }),
    );
  }

  /**
   * Ack on success and on a business refusal alike; leave the message unacked
   * only when the handler blew up for an unexpected reason, where a redelivery
   * has a real chance of succeeding.
   */
  private async settle<T>(
    context: RmqContext,
    handler: () => Promise<T>,
  ): Promise<T> {
    const channel = context.getChannelRef() as {
      ack: (message: unknown) => void;
    };
    const message = context.getMessage();

    try {
      const result = await handler();

      channel.ack(message);

      return result;
    } catch (error) {
      // A rejected password or a wrong code will be rejected identically on
      // every redelivery, so the message is done with: ack it and let the
      // error travel back to the caller as the reply.
      if (error instanceof AppError) {
        channel.ack(message);
      }

      throw error;
    }
  }
}
