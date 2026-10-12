import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

import type { TransformationHistoryPage } from '@contracts/messages/conversion.messages';
import { correlationIdFor } from '@core/messaging/correlation-id';
import { CurrentUser, type RequestUser } from '../auth/request-user';
import { ErrorResponseDto } from '../shared/api-responses.dto';
import {
  TransformationHistoryPageDto,
  TransformationHistoryQueryDto,
  TransformationUserParamsDto,
} from './dto/transformations.dto';
import { TransformationsService } from './transformations.service';

const MINUTE_MS = 60_000;

const FILTERS_DESCRIPTION = [
  'Finished transformations — files and images — newest first, cursor-paged.',
  'Filters combine: `type`, `sourceFormat`, `targetFormat`, `status`, and a `createdAtFrom`–`createdAtTo` range (inclusive).',
  'No file names, checksums or other personal data — see docs/TRANSFORMATION-HISTORY.md.',
].join('\n\n');

@ApiTags('convert')
@ApiResponse({
  status: 400,
  description:
    '`VALIDATION_FAILED` — a filter, the limit, the cursor, or a date range that ends before it starts.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 401,
  description: 'No session.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 429,
  description: 'Too many requests.',
  type: ErrorResponseDto,
})
@Controller('api/transformations')
export class TransformationsController {
  constructor(private readonly transformations: TransformationsService) {}

  @ApiOperation({
    summary: 'Your transformation history',
    description: FILTERS_DESCRIPTION,
  })
  @ApiResponse({ status: 200, type: TransformationHistoryPageDto })
  @Get('history')
  @Throttle({ default: { limit: 120, ttl: MINUTE_MS } })
  history(
    @Query() query: TransformationHistoryQueryDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<TransformationHistoryPage> {
    return this.transformations.history(
      user,
      { kind: 'self' },
      query,
      correlationIdFor(request),
    );
  }
}

/**
 * Another user's history. Not behind `@Permissions` on purpose: the
 * permission is checked in the service, so a refusal is audited with the
 * rest (docs/TRANSFORMATION-HISTORY.md §4). Tighter limits than a user's own
 * — reading other people's records is the thing to slow down.
 */
@ApiTags('admin')
@ApiParam({ name: 'userId', format: 'uuid', description: 'Whose history.' })
@ApiResponse({
  status: 400,
  description:
    '`VALIDATION_FAILED` — the id, a filter, the limit or the cursor.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 401,
  description: 'No session.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 403,
  description: 'The caller does not hold `transformations@read`.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 404,
  description: '`USER_NOT_FOUND` — no such user, or an erased one.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 429,
  description: 'Too many requests.',
  type: ErrorResponseDto,
})
@Controller('admin/users/:userId/transformations')
export class AdminTransformationsController {
  constructor(private readonly transformations: TransformationsService) {}

  @ApiOperation({
    summary: "A user's transformation history",
    description: `Needs \`transformations@read\`.\n\n${FILTERS_DESCRIPTION}`,
  })
  @ApiResponse({ status: 200, type: TransformationHistoryPageDto })
  @Get('history')
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  history(
    @Param() params: TransformationUserParamsDto,
    @Query() query: TransformationHistoryQueryDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<TransformationHistoryPage> {
    return this.transformations.history(
      user,
      { kind: 'admin', targetUserId: params.userId },
      query,
      correlationIdFor(request),
    );
  }
}
