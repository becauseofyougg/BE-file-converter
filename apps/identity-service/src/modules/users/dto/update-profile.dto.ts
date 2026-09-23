import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  DISPLAY_NAME_MAX_LENGTH,
  type ConfirmEmailChangeRequest,
  type StartEmailChangeRequest,
  type UpdateUserProfileRequest,
  type UserPatch,
} from '@contracts/messages/users.messages';
import { OTP_LENGTH } from '../../auth/verification.service';

/**
 * Only the two writable fields exist here at all. `whitelist` plus
 * `forbidNonWhitelisted` means anything else is a `400` at the boundary, before
 * the field policy ever runs — the policy decides who may write *these*, and an
 * unknown field never gets that far.
 */
export class UserPatchDto implements UserPatch {
  /**
   * Nullable to clear it. Trimmed length is checked in the service; `MinLength`
   * here would reject `""` where the caller plainly meant `null`, which is a
   * worse error message than the one they get for an empty name.
   */
  @IsOptional()
  @IsString()
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  displayName?: string | null;

  /** Refused for Self by the field policy, not here — the message differs. */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class UpdateUserProfileMessageDto implements UpdateUserProfileRequest {
  @IsUUID()
  targetUserId: string;

  @IsUUID()
  viewerUserId: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @ArrayMaxSize(64)
  viewerRoles: string[];

  @IsObject()
  @ValidateNested()
  @Type(() => UserPatchDto)
  patch: UserPatchDto;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}

export class StartEmailChangeMessageDto implements StartEmailChangeRequest {
  @IsUUID()
  targetUserId: string;

  @IsUUID()
  viewerUserId: string;

  @IsEmail()
  @MinLength(3)
  @MaxLength(254)
  newEmail: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}

export class ConfirmEmailChangeMessageDto implements ConfirmEmailChangeRequest {
  @IsUUID()
  targetUserId: string;

  @IsOptional()
  @IsUUID()
  challengeId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(OTP_LENGTH, { message: 'code must be a 6-digit code' })
  @MinLength(OTP_LENGTH, { message: 'code must be a 6-digit code' })
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  token?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}
