import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** Kept in step with identity-service's own policy constants. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const OTP_LENGTH = 6;

const normalize = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const CHALLENGE_ID = {
  description:
    'The handle returned when the challenge was issued. Quote it back with `code`.',
  format: 'uuid',
} as const;

const OTP_CODE = {
  description: 'The six-digit code from the email.',
  example: '123456',
  minLength: OTP_LENGTH,
  maxLength: OTP_LENGTH,
} as const;

const LINK_TOKEN = {
  description:
    'The token from a magic link, used instead of `challengeId` + `code`.',
  maxLength: 128,
} as const;

export class RegisterDto {
  /**
   * Normalised at the edge as well as in the service, so what is validated,
   * what is rate-limited and what is stored are the same string.
   */
  @ApiProperty({ format: 'email', maxLength: 254, example: 'ada@example.com' })
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  email: string;

  /**
   * Bounded but not shaped: the composition rules live in identity-service,
   * which owns the policy and returns `PASSWORD_TOO_WEAK` when it is broken.
   * Duplicating them here would mean two places to change and two answers
   * when they drift.
   */
  @ApiProperty({
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description:
      'Length is the only rule enforced here. The rest of the policy lives in identity-service, which answers `PASSWORD_TOO_WEAK`.',
  })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

/**
 * No minimum length, unlike registration: the policy may have been tightened
 * since this account was created, and rejecting a short password here would
 * tell an attacker that anything shorter is not worth trying.
 */
export class LoginDto {
  @ApiProperty({ format: 'email', maxLength: 254, example: 'ada@example.com' })
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({
    maxLength: PASSWORD_MAX_LENGTH,
    description:
      'No minimum here, unlike registration — refusing a short password would tell an attacker not to bother trying shorter ones.',
  })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class ConfirmLoginDto {
  @ApiPropertyOptional(CHALLENGE_ID)
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @ApiPropertyOptional(OTP_CODE)
  @IsOptional()
  @IsString()
  @Length(OTP_LENGTH, OTP_LENGTH)
  code?: string;

  /** The magic-link token, when that is the configured method. */
  @ApiPropertyOptional(LINK_TOKEN)
  @IsOptional()
  @IsString()
  @MaxLength(128)
  token?: string;
}

export class ResendLoginConfirmationDto {
  @ApiProperty(CHALLENGE_ID)
  @IsUUID()
  challengeId: string;
}

export class VerifyEmailDto {
  @ApiPropertyOptional(CHALLENGE_ID)
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @ApiPropertyOptional(OTP_CODE)
  @IsOptional()
  @IsString()
  @Length(OTP_LENGTH, OTP_LENGTH)
  code?: string;

  /** The magic-link token, when that is the configured method. */
  @ApiPropertyOptional(LINK_TOKEN)
  @IsOptional()
  @IsString()
  @MaxLength(128)
  token?: string;
}

export class ResendVerificationDto {
  @ApiPropertyOptional(CHALLENGE_ID)
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @ApiPropertyOptional({
    format: 'email',
    maxLength: 254,
    description:
      'Used when the client no longer holds the `challengeId` from registration.',
  })
  @Transform(normalize)
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
