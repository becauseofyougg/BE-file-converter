import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import type { GetUserProfileRequest } from '@contracts/messages/users.messages';

/**
 * `viewerUserId` and `viewerRoles` come from the gateway's verified access
 * token, never from anything a client sent. They are validated here all the
 * same: this boundary is checked independently of the edge, so a second caller
 * appearing on the queue cannot skip the checks the first one passed.
 */
export class GetUserProfileMessageDto implements GetUserProfileRequest {
  @IsUUID()
  targetUserId: string;

  @IsUUID()
  viewerUserId: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @ArrayMaxSize(64)
  viewerRoles: string[];

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}
