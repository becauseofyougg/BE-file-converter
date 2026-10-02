import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type {
  ConversionFormatEntry,
  ConversionHistoryPage,
  ConversionOperationRecord,
} from '@contracts/messages/conversion.messages';
import { correlationIdFor } from '@core/messaging/correlation-id';
import { CurrentUser, type RequestUser } from '../auth/request-user';
import { ErrorResponseDto } from '../shared/api-responses.dto';
import {
  ConversionsService,
  type DownloadableResult,
} from './conversions.service';
import {
  ConversionFormatEntryDto,
  ConversionHistoryPageDto,
  ConversionHistoryQueryDto,
  ConversionOperationDto,
  ConversionParamsDto,
} from './dto/conversions.dto';

const MINUTE_MS = 60_000;

/** Header carrying the history id of the conversion a download came from. */
export const CONVERSION_ID_HEADER = 'x-conversion-id';

const RESULT_TYPES = [
  'text/csv',
  'application/json',
  'application/xml',
  'application/yaml',
];

/**
 * docs/CONVERSIONS.md. Under `/api`, unlike the older routes — the prefix is
 * this module's, so nothing else moves.
 *
 * Every route needs a session and nothing more: converting is what an
 * account is for, and a user only ever sees their own history.
 */
@ApiTags('convert')
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
@Controller('api/convert')
export class ConversionsController {
  constructor(private readonly conversions: ConversionsService) {}

  @ApiOperation({
    summary: 'Convert a file',
    description: [
      'Upload one file and get it back converted, in the same response.',
      '',
      'The source format is recognised from the file name (`.csv`, `.json`, `.xml`, `.yaml`/`.yml`), or',
      'from the content for JSON and XML. Each source format has its own size limit, set by the',
      'operator. Every conversion is recorded in the history; the result itself is kept only with',
      '`save=true`. How data is mapped between the formats is in docs/CONVERSIONS.md.',
    ].join('\n'),
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'targetFormat'],
      properties: {
        file: { type: 'string', format: 'binary' },
        targetFormat: {
          type: 'string',
          example: 'json',
          description:
            'One of the targets `GET /api/convert/formats` lists for the source.',
        },
        save: {
          type: 'boolean',
          default: false,
          description: 'Keep the result, to download again from the history.',
        },
      },
    },
  })
  @ApiProduces(...RESULT_TYPES)
  @ApiResponse({
    status: 200,
    description:
      'The converted file, as `attachment; filename="converted.<ext>"`. `X-Conversion-Id` names the history entry.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({
    status: 400,
    description:
      '`VALIDATION_FAILED` — the form is wrong; `UNSUPPORTED_CONVERSION` — no such target, or not from this source; `INVALID_SOURCE` — empty, not UTF-8, or not valid in its format.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 413,
    description: '`FILE_TOO_LARGE` — over the limit for its format.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 415,
    description: '`UNSUPPORTED_FORMAT` — not a format this service reads.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 422,
    description: '`CONVERSION_TIMEOUT` — did not finish in time.',
    type: ErrorResponseDto,
  })
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: MINUTE_MS } })
  async convert(
    @Req() request: FastifyRequest,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const result = await this.conversions.convert(
      request,
      user.id,
      correlationIdFor(request),
    );

    return this.send(reply, result);
  }

  @ApiOperation({
    summary: 'What converts to what',
    description:
      'Every source format, with every format it can be converted to.',
  })
  @ApiResponse({ status: 200, type: [ConversionFormatEntryDto] })
  @Get('formats')
  @Throttle({ default: { limit: 120, ttl: MINUTE_MS } })
  formats(@Req() request: FastifyRequest): Promise<ConversionFormatEntry[]> {
    return this.conversions.formats(correlationIdFor(request));
  }

  @ApiOperation({
    summary: 'Your conversions, newest first',
    description:
      'Every conversion you have run, saved or not, including failures.',
  })
  @ApiResponse({ status: 200, type: ConversionHistoryPageDto })
  @Get('history')
  @Throttle({ default: { limit: 120, ttl: MINUTE_MS } })
  history(
    @Query() query: ConversionHistoryQueryDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<ConversionHistoryPage> {
    return this.conversions.history({
      userId: user.id,
      cursor: query.cursor,
      limit: query.limit,
      correlationId: correlationIdFor(request),
    });
  }

  @ApiOperation({ summary: 'One of your conversions' })
  @ApiResponse({ status: 200, type: ConversionOperationDto })
  @ApiResponse({
    status: 404,
    description: '`JOB_NOT_FOUND` — none of yours has this id.',
    type: ErrorResponseDto,
  })
  @Get('history/:operationId')
  @Throttle({ default: { limit: 120, ttl: MINUTE_MS } })
  operation(
    @Param() params: ConversionParamsDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
  ): Promise<ConversionOperationRecord> {
    return this.conversions.operation({
      userId: user.id,
      operationId: params.operationId,
      correlationId: correlationIdFor(request),
    });
  }

  @ApiOperation({
    summary: 'Download a saved result',
    description: 'Only for a conversion run with `save=true`.',
  })
  @ApiProduces(...RESULT_TYPES)
  @ApiResponse({ status: 200, schema: { type: 'string', format: 'binary' } })
  @ApiResponse({
    status: 404,
    description:
      '`JOB_NOT_FOUND` — none of yours has this id; `RESULT_NOT_SAVED` — it was not saved, or did not succeed.',
    type: ErrorResponseDto,
  })
  @Get('history/:operationId/download')
  @Throttle({ default: { limit: 60, ttl: MINUTE_MS } })
  async download(
    @Param() params: ConversionParamsDto,
    @CurrentUser() user: RequestUser,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    const result = await this.conversions.download({
      userId: user.id,
      operationId: params.operationId,
      correlationId: correlationIdFor(request),
    });

    return this.send(reply, result);
  }

  private send(
    reply: FastifyReply,
    result: DownloadableResult,
  ): StreamableFile {
    void reply.header(CONVERSION_ID_HEADER, result.operationId);

    return new StreamableFile(result.stream, {
      type: result.file.contentType,
      disposition: `attachment; filename="${result.file.fileName}"`,
      length: result.file.size,
    });
  }
}
