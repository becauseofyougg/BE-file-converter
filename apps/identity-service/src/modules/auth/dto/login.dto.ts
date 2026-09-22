import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

import type { LoginRequest } from '@contracts/messages/identity.messages';
import { PASSWORD_MAX_LENGTH } from '../password.service';
import { OTP_LENGTH } from '../verification.service';

/**
 * No minimum length on the password, deliberately — unlike registration.
 *
 * The policy may have been tightened since this account was created, and
 * rejecting a short password at the DTO would tell an attacker that anything
 * shorter is not worth trying. Login checks the hash and nothing else.
 */
export class LoginMessageDto implements LoginRequest {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;

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

export class ConfirmLoginMessageDto {
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

export class ResendLoginConfirmationMessageDto {
  @IsUUID()
  challengeId: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}
