import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  USER_LIST_LIMITS,
  USER_LIST_SORTS,
  USER_SEARCH_MAX_LENGTH,
  USER_STATUSES,
  type ListUsersRequest,
  type SortOrder,
  type UserListSort,
  type UserStatus,
} from '@contracts/messages/users.messages';

/**
 * `sort`, `order` and `status` are closed sets, checked against the constants
 * rather than accepted as strings. They end up in an `ORDER BY` and a `WHERE`,
 * and the one reliable way to keep a caller from steering those is never to let
 * an unrecognised value past the boundary.
 */
export class ListUsersMessageDto implements ListUsersRequest {
  @IsUUID()
  viewerUserId: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @ArrayMaxSize(64)
  viewerRoles: string[];

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(USER_LIST_LIMITS.MIN)
  @Max(USER_LIST_LIMITS.MAX)
  limit?: number;

  /** Bounded so a pathological pattern cannot be handed to the database. */
  @IsOptional()
  @IsString()
  @MaxLength(USER_SEARCH_MAX_LENGTH)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(USER_STATUSES))
  status?: UserStatus;

  @IsOptional()
  @IsIn(Object.values(USER_LIST_SORTS))
  sort?: UserListSort;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: SortOrder;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  correlationId?: string;
}
