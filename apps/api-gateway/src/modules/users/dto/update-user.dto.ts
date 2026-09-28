import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

import {
  DELETION_REASON_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  type UserPatch,
} from '@contracts/messages/users.messages';

const OTP_LENGTH = 6;

/**
 * The writable fields, and only those. With `whitelist` and
 * `forbidNonWhitelisted` on the global pipe, a patch naming anything else is a
 * `400` before the field policy runs — the policy decides *who* may write these
 * two, and an unknown field never reaches it.
 */
export class UpdateUserDto implements UserPatch {
  @ApiPropertyOptional({
    nullable: true,
    maxLength: DISPLAY_NAME_MAX_LENGTH,
    description: 'null clears it; a blank string is treated as null.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  displayName?: string | null;

  /**
   * Present in the DTO because an administrator may send it. A Self who does is
   * refused by the field policy with a message pointing at the confirmation
   * flow — a `400` here would say "no such field", which is not true and does
   * not help.
   */
  @ApiPropertyOptional({
    format: 'email',
    description:
      'Administrators only. A Self sending this is refused with `FIELD_NOT_WRITABLE` and pointed at the email-change flow.',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class StartEmailChangeDto {
  @ApiProperty({
    format: 'email',
    description:
      'The address being claimed. A code or link goes here, not to the current address.',
  })
  @IsEmail()
  @MaxLength(254)
  newEmail: string;
}

export class DeleteUserDto {
  /** Free text for the audit trail. It changes nothing about the erasure. */
  @ApiPropertyOptional({
    maxLength: DELETION_REASON_MAX_LENGTH,
    description:
      'Recorded in the audit log. It changes nothing about the erasure.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(DELETION_REASON_MAX_LENGTH)
  reason?: string;
}

/** Variant A quotes a code against a challenge; variant B carries a link token. */
export class ConfirmDeletionDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @ApiPropertyOptional({
    example: '123456',
    minLength: OTP_LENGTH,
    maxLength: OTP_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(OTP_LENGTH, OTP_LENGTH)
  code?: string;

  @ApiPropertyOptional({
    description: 'From a magic link, used instead of challengeId + code.',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  token?: string;
}

/** Variant A quotes a code against a challenge; variant B carries a link token. */
export class ConfirmEmailChangeDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @ApiPropertyOptional({
    example: '123456',
    minLength: OTP_LENGTH,
    maxLength: OTP_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Length(OTP_LENGTH, OTP_LENGTH)
  code?: string;

  @ApiPropertyOptional({
    description: 'From a magic link, used instead of challengeId + code.',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  token?: string;
}
