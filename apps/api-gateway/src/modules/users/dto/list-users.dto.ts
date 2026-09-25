import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  USER_LIST_LIMITS,
  USER_LIST_SORTS,
  USER_SEARCH_MAX_LENGTH,
  USER_STATUSES,
  type SortOrder,
  type UserListSort,
  type UserStatus,
} from '@contracts/messages/users.messages';

/**
 * The query string of `GET /admin/users` — docs/USER-LIST.md §2.
 *
 * Everything that reaches an `ORDER BY` or a `WHERE` is a closed set checked
 * against the contract's constants, never a free string. `limit` is bounded on
 * both sides: unbounded, a single request could ask for the whole user table.
 *
 * `@Type(() => Number)` is required because a query string has no types —
 * without it `limit` arrives as `"20"` and every numeric rule silently passes.
 */
export class ListUsersQueryDto {
  @ApiPropertyOptional({
    description:
      'From the previous page. Opaque — never construct one, and it is only valid for the sort it was issued under.',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({
    minimum: USER_LIST_LIMITS.MIN,
    maximum: USER_LIST_LIMITS.MAX,
    default: USER_LIST_LIMITS.DEFAULT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(USER_LIST_LIMITS.MIN)
  @Max(USER_LIST_LIMITS.MAX)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Matches an exact id, an exact address, or part of a display name. Substring search on the address is deliberately not offered.',
    maxLength: USER_SEARCH_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(USER_SEARCH_MAX_LENGTH)
  q?: string;

  @ApiPropertyOptional({
    enum: Object.values(USER_STATUSES),
    description:
      'Omit for live accounts only — erased ones are excluded by default.',
  })
  @IsOptional()
  @IsIn(Object.values(USER_STATUSES))
  status?: UserStatus;

  @ApiPropertyOptional({
    enum: Object.values(USER_LIST_SORTS),
    default: 'created_at',
  })
  @IsOptional()
  @IsIn(Object.values(USER_LIST_SORTS))
  sort?: UserListSort;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: SortOrder;
}
