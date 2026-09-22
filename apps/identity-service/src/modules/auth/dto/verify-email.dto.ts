import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

import type {
  ResendVerificationRequest,
  VerifyEmailRequest,
} from '@contracts/messages/identity.messages';
import { OTP_LENGTH } from '../verification.service';

/**
 * Two shapes on one endpoint: `challengeId` + `code` for OTP, or a bare
 * `token` for a magic link. Which one is required depends on the configured
 * method, so the service — not the DTO — rejects an empty submission.
 */
export class VerifyEmailMessageDto implements VerifyEmailRequest {
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @IsOptional()
  @IsString()
  @Length(OTP_LENGTH, OTP_LENGTH)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  token?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  userAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ip?: string;
}

export class ResendVerificationMessageDto implements ResendVerificationRequest {
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}
