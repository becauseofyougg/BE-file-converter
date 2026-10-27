import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  type StreamableFile,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type {
  ConversionOperationRecord,
  TransformationHistoryPage,
} from '@contracts/messages/conversion.messages';
import { correlationIdFor } from '@core/messaging/correlation-id';
import { CurrentUser, type RequestUser } from '../auth/request-user';
import { attachment, RESULT_TYPES } from '../conversions/attachment';
import { ConversionOperationDto } from '../conversions/dto/conversions.dto';
import { ErrorResponseDto } from '../shared/api-responses.dto';
import {
  AdminTransformationItemParamsDto,
  TransformationHistoryPageDto,
  TransformationHistoryQueryDto,
  TransformationItemParamsDto,
  TransformationUserParamsDto,
} from './dto/transformations.dto';
import { TransformationsService } from './transformations.service';

const MINUTE_MS = 60_000;

const SAVED_DOWNLOAD_DESCRIPTION = [
  'A result kept with `save=true`, streamed, named after the upload with the new extension. Until the history retention period ends; after that, 410.',
  'See docs/SAVED-RESULTS.md.',
].join('\n\n');

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

  @ApiOperation({
    summary: 'One of your transformations, in full',
    description:
      'Everything the list leaves out: the file name, sizes and checksums, the options, the error message.',
  })
  @ApiResponse({ status: 200, type: ConversionOperationDto })
  @ApiResponse({
    status: 404,
    description: '`JOB_NOT_FOUND` — none of yours has this id.',
    type: ErrorResponseDto,
  })
  @Get('history/:itemId')
  @Throttle({ default: { limit: 120, ttl: MINUTE_MS } })
  operation(
    @Param() params: TransformationItemParamsDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<ConversionOperationRecord> {
    return this.transformations.operation(
      user,
      params.itemId,
      correlationIdFor(request),
    );
  }

  @ApiOperation({
    summary: 'Download a saved result',
    description: SAVED_DOWNLOAD_DESCRIPTION,
  })
  @ApiProduces(...RESULT_TYPES)
  @ApiResponse({
    status: 200,
    description:
      'The file, named after the upload: `people.csv` → `people.json`.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({
    status: 404,
    description:
      '`JOB_NOT_FOUND` — none of yours has this id; `RESULT_NOT_SAVED` — it was not saved, or has no result.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 410,
    description: '`RESULT_EXPIRED` — it was saved, and its time has passed.',
    type: ErrorResponseDto,
  })
  @Get('history/:itemId/download')
  @Throttle({ default: { limit: 60, ttl: MINUTE_MS } })
  async download(
    @Param() params: TransformationItemParamsDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    return attachment(
      reply,
      await this.transformations.download(
        user,
        { kind: 'self' },
        params.itemId,
        correlationIdFor(request),
      ),
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

  @ApiOperation({
    summary: "Download a user's saved result",
    description: `Needs \`transformations@read\`.\n\n${SAVED_DOWNLOAD_DESCRIPTION}`,
  })
  @ApiParam({
    name: 'itemId',
    format: 'uuid',
    description: 'The history entry.',
  })
  @ApiProduces(...RESULT_TYPES)
  @ApiResponse({
    status: 200,
    description: 'The file, named after the upload.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({
    status: 410,
    description: '`RESULT_EXPIRED` — it was saved, and its time has passed.',
    type: ErrorResponseDto,
  })
  @Get('history/:itemId/download')
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  async download(
    @Param() params: AdminTransformationItemParamsDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    return attachment(
      reply,
      await this.transformations.download(
        user,
        { kind: 'admin', targetUserId: params.userId },
        params.itemId,
        correlationIdFor(request),
      ),
    );
  }
}
