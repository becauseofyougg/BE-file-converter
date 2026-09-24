import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

import {
  DELETION_REASON_MAX_LENGTH,
  type ConfirmDeletionRequest,
  type DeleteUserRequest,
} from '@contracts/messages/users.messages';
import { OTP_LENGTH } from '../../auth/verification.service';

export class DeleteUserMessageDto implements DeleteUserRequest {
  @IsUUID()
  targetUserId: string;

  @IsUUID()
  viewerUserId: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @ArrayMaxSize(64)
  viewerRoles: string[];

  /** Bounded, because it goes straight into the audit log. */
  @IsOptional()
  @IsString()
  @MaxLength(DELETION_REASON_MAX_LENGTH)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}

export class ConfirmDeletionMessageDto implements ConfirmDeletionRequest {
  @IsUUID()
  targetUserId: string;

  /**
   * Required, unlike the email-change confirmation: erasing an account needs a
   * session belonging to that account as well as the emailed secret.
   */
  @IsUUID()
  viewerUserId: string;

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
}
