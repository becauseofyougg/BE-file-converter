import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

import {
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
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class StartEmailChangeDto {
  @IsEmail()
  @MaxLength(254)
  newEmail: string;
}

/** Variant A quotes a code against a challenge; variant B carries a link token. */
export class ConfirmEmailChangeDto {
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
}
