import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  IDENTITY_PATTERNS,
  type ConfirmLoginResponse,
  type LoginResponse,
  type RefreshResponse,
  type RegisterResponse,
  type ResendVerificationResponse,
  type VerifyEmailResponse,
} from '@contracts/messages/identity.messages';
import { IDENTITY_CLIENT } from '../../messaging/messaging.module';
import { sendRpc } from '../../messaging/rpc';

export interface CallerContext {
  correlationId: string;
  userAgent?: string;
  ip?: string;
}

/**
 * A thin forwarder. The gateway owns no auth logic of its own — putting any
 * of it here would mean two services deciding who may register, and the one
 * that owns the data losing.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(IDENTITY_CLIENT) private readonly identity: ClientProxy,
  ) {}

  register(
    input: { email: string; password: string },
    caller: CallerContext,
  ): Promise<RegisterResponse> {
    return sendRpc<RegisterResponse, Record<string, unknown>>(
      this.identity,
      IDENTITY_PATTERNS.REGISTER,
      { ...input, ...caller },
    );
  }

  verifyEmail(
    input: { challengeId?: string; code?: string; token?: string },
    caller: CallerContext,
  ): Promise<VerifyEmailResponse> {
    return sendRpc<VerifyEmailResponse, Record<string, unknown>>(
      this.identity,
      IDENTITY_PATTERNS.VERIFY_EMAIL,
      { ...input, ...caller },
    );
  }

  resendVerification(
    input: { challengeId?: string; email?: string },
    caller: CallerContext,
  ): Promise<ResendVerificationResponse> {
    return sendRpc<ResendVerificationResponse, Record<string, unknown>>(
      this.identity,
      IDENTITY_PATTERNS.RESEND_VERIFICATION,
      { ...input, correlationId: caller.correlationId },
    );
  }
  login(
    input: { email: string; password: string },
    caller: CallerContext,
  ): Promise<LoginResponse> {
    return sendRpc<LoginResponse, Record<string, unknown>>(
      this.identity,
      IDENTITY_PATTERNS.LOGIN,
      { ...input, ...caller },
    );
  }

  confirmLogin(
    input: { challengeId?: string; code?: string; token?: string },
    caller: CallerContext,
  ): Promise<ConfirmLoginResponse> {
    return sendRpc<ConfirmLoginResponse, Record<string, unknown>>(
      this.identity,
      IDENTITY_PATTERNS.CONFIRM_LOGIN,
      { ...input, ...caller },
    );
  }

  /**
   * The gateway holds the access secret and could verify a refresh token
   * locally, but it does not hold the refresh secret and has no way to re-read
   * the account's roles — which is the point of refreshing at all. Identity
   * stays the only issuer.
   */
  refresh(
    refreshToken: string,
    caller: CallerContext,
  ): Promise<RefreshResponse> {
    return sendRpc<RefreshResponse, Record<string, unknown>>(
      this.identity,
      IDENTITY_PATTERNS.REFRESH,
      { refreshToken, correlationId: caller.correlationId },
    );
  }

  resendLoginConfirmation(
    challengeId: string,
    caller: CallerContext,
  ): Promise<{ status: 'accepted' }> {
    return sendRpc<{ status: 'accepted' }, Record<string, unknown>>(
      this.identity,
      IDENTITY_PATTERNS.RESEND_LOGIN_CONFIRMATION,
      { challengeId, correlationId: caller.correlationId },
    );
  }
}
