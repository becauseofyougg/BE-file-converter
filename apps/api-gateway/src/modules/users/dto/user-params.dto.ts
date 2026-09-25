import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * A malformed id is a `400`, not a `404`.
 *
 * The distinction is not pedantry: "that is not a user id" says nothing about
 * anybody, while "no such user" is a fact about the namespace. Refusing the
 * shape before the lookup also keeps the route from becoming a cheap way to
 * probe it — see docs/USER-PROFILE.md §3.
 */
export class UserParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId: string;
}
