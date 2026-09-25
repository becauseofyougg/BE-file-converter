import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import {
  USER_LIST_SORTS,
  USER_STATUSES,
  type UserStatus,
} from '@contracts/messages/users.messages';

/**
 * Response shapes, declared for the OpenAPI document —
 * NON-FUNCTIONAL-REQUIREMENTS.md §8.
 *
 * They are documentation classes, not runtime types: the handlers build plain
 * objects from contract interfaces, and these describe what comes out. Keeping
 * them here rather than inside each module is deliberate — every one of them
 * appears in more than one endpoint's response, and a copy per module is how
 * two endpoints end up documenting the same shape differently.
 */

export class ErrorResponseDto {
  @ApiProperty({
    enum: Object.values(ERROR_CODES),
    description:
      'Stable identifier from a closed set. Branch on this, never on `message`.',
    example: ERROR_CODES.VALIDATION_FAILED,
  })
  code: string;

  @ApiProperty({ description: 'Human-readable, and subject to change.' })
  message: string;

  @ApiPropertyOptional({
    description:
      'Shape depends on `code` — the offending fields, a `retryAfterSeconds`, and so on.',
    type: Object,
  })
  details?: unknown;

  @ApiProperty({
    description:
      'Echoes the inbound `x-correlation-id`, or the one generated at the edge. Quote it in a bug report.',
  })
  correlationId: string;
}

/**
 * What a completed sign-in returns. **Neither token is in the body** — both go
 * into `httpOnly` cookies, which is the point of the scheme.
 */
export class SessionResponseDto {
  @ApiProperty({ example: 'authenticated' })
  status: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the access cookie expires, so a client can refresh before a request fails rather than after.',
  })
  accessTokenExpiresAt: string;
}

/** The other half of the same contract: a challenge to complete first. */
export class ConfirmationRequiredDto {
  @ApiProperty({ example: 'confirmation_required' })
  status: string;

  @ApiProperty({ format: 'uuid' })
  challengeId: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}

/** Deliberately says nothing about whether the account exists. */
export class AcceptedDto {
  @ApiProperty({ example: 'accepted' })
  status: string;
}

export class UserProfileDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ format: 'email' })
  email?: string;

  @ApiPropertyOptional({ nullable: true })
  displayName?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'A short-lived presigned URL, or null. Never a storage key.',
  })
  photo?: string | null;

  @ApiPropertyOptional()
  emailVerified?: boolean;

  @ApiPropertyOptional({ format: 'date-time' })
  createdAt?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Only ever returned to the account itself.',
  })
  roles?: string[];
}

export class UserListItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'email' })
  email: string;

  @ApiProperty({ nullable: true })
  displayName: string | null;

  @ApiProperty({ nullable: true, description: 'Short-lived presigned URL.' })
  photo: string | null;

  @ApiProperty({ enum: Object.values(USER_STATUSES) })
  status: UserStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastLoginAt: string | null;
}

export class UserListResponseDto {
  @ApiProperty({ type: [UserListItemDto] })
  items: UserListItemDto[];

  @ApiProperty({
    nullable: true,
    description:
      'Pass back as `?cursor=` for the next page; null on the last. Opaque — never construct one, and it is only valid for the sort it was issued under.',
  })
  nextCursor: string | null;
}

export class StartEmailChangeResponseDto {
  @ApiProperty({ example: true })
  requiresConfirmation: boolean;

  @ApiProperty({ format: 'uuid' })
  challengeId: string;

  @ApiProperty({ enum: ['otp', 'link'] })
  method: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}

export class EmailChangedResponseDto {
  @ApiProperty({ example: 'email_changed' })
  status: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ format: 'email' })
  email: string;
}

/** The sort keys, re-exported so the query DTO and the docs cannot disagree. */
export const LIST_SORT_VALUES = Object.values(USER_LIST_SORTS);
