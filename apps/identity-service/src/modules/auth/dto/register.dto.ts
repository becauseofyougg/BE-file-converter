import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

import type { RegisterRequest } from '@contracts/messages/identity.messages';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password.service';

/**
 * A message off the broker is exactly as untrusted as a browser request — the
 * gateway validated its own DTO, but nothing proves the message came from the
 * gateway. See NON-FUNCTIONAL-REQUIREMENTS.md §4.2.
 */
export class RegisterMessageDto implements RegisterRequest {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
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
