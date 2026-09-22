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

export class RegisterDto {
  /**
   * Normalised at the edge as well as in the service, so what is validated,
   * what is rate-limited and what is stored are the same string.
   */
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
  @Transform(normalize)
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

export class ConfirmLoginDto {
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @IsOptional()
  @IsString()
  @Length(OTP_LENGTH, OTP_LENGTH)
  code?: string;

  /** The magic-link token, when that is the configured method. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  token?: string;
}

export class ResendLoginConfirmationDto {
  @IsUUID()
  challengeId: string;
}

export class VerifyEmailDto {
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @IsOptional()
  @IsString()
  @Length(OTP_LENGTH, OTP_LENGTH)
  code?: string;

  /** The magic-link token, when that is the configured method. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  token?: string;
}

export class ResendVerificationDto {
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @Transform(normalize)
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
