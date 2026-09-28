import { Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import type {
  DeletionRequestedPayload,
  EmailChangedPayload,
  EmailChangeRequestedPayload,
  LoginConfirmationRequestedPayload,
  UserDeletedPayload,
  UserRegisteredPayload,
  UserRegistrationAttemptedPayload,
} from '@contracts/events/domain.events';

/**
 * Runtime shapes for the events this service consumes. A message from another
 * service is exactly as untrusted as a request from a browser — the contract
 * types say what identity *meant* to send, not what arrived.
 *
 * Each class `implements` its contract interface, so a field renamed on the
 * publisher's side stops this file compiling rather than silently failing
 * validation in production.
 */

const CONFIRMATION_METHODS = ['otp', 'link'] as const;

/** A code is 6 digits and a link token 43 base64url characters; this is slack. */
const MAX_SECRET_LENGTH = 256;

export class EventEnvelopeDto {
  @IsUUID()
  eventId!: string;

  @IsString()
  @IsNotEmpty()
  eventName!: string;

  @IsISO8601()
  occurredAt!: string;

  @IsString()
  @MaxLength(128)
  correlationId!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class ConfirmationDto {
  @IsIn(CONFIRMATION_METHODS)
  method!: 'otp' | 'link';

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_SECRET_LENGTH)
  secret!: string;

  @IsISO8601()
  expiresAt!: string;
}

/** Also the shape of `user.verification_resent`. */
export class UserRegisteredDto implements UserRegisteredPayload {
  @IsUUID()
  userId!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ConfirmationDto)
  confirmation?: ConfirmationDto;
}

export class RegistrationAttemptedDto implements UserRegistrationAttemptedPayload {
  @IsUUID()
  userId!: string;

  @IsEmail()
  email!: string;
}

export class LoginConfirmationRequestedDto
  extends ConfirmationDto
  implements LoginConfirmationRequestedPayload
{
  @IsUUID()
  userId!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  userAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ip?: string;
}

export class EmailChangeRequestedDto
  extends ConfirmationDto
  implements EmailChangeRequestedPayload
{
  @IsUUID()
  userId!: string;

  @IsEmail()
  newEmail!: string;
}

export class EmailChangedDto implements EmailChangedPayload {
  @IsUUID()
  userId!: string;

  @IsEmail()
  previousEmail!: string;

  @IsEmail()
  newEmail!: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}

export class DeletionRequestedDto
  extends ConfirmationDto
  implements DeletionRequestedPayload
{
  @IsUUID()
  userId!: string;

  @IsEmail()
  email!: string;
}

export class UserDeletedDto implements UserDeletedPayload {
  @IsUUID()
  userId!: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  photoKey?: string | null;

  @IsISO8601()
  deletedAt!: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;
}
