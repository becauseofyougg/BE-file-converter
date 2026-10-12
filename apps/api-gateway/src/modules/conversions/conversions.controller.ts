import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  type StreamableFile,
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
  ConversionOperationRecord,
} from '@contracts/messages/conversion.messages';
import { correlationIdFor } from '@core/messaging/correlation-id';
import { CurrentUser, type RequestUser } from '../auth/request-user';
import { ErrorResponseDto } from '../shared/api-responses.dto';
import { attachment, RESULT_TYPES } from './attachment';
import { ConversionsService } from './conversions.service';
import {
  ConversionFormatEntryDto,
  ConversionOperationDto,
  ConversionParamsDto,
} from './dto/conversions.dto';

const MINUTE_MS = 60_000;

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
      'Every registered format: CSV, JSON, XML, YAML, and the images (PNG, JPEG, SVG) that',
      '`POST /api/images/convert` also serves. The source format is recognised from its signature',
      '(PNG, JPEG), its file name, or its content (JSON, XML, SVG). Each source format has its own',
      'size limit, set by the operator. Every conversion is recorded in the history; the result',
      'itself is kept only with `save=true`. The rules are in docs/CONVERSIONS.md and docs/IMAGES.md.',
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
        options: {
          type: 'string',
          example: '{"quality":80}',
          description:
            'A JSON object of settings, for a direction that takes any — see `POST /api/images/convert`. Text formats take none.',
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
      '`VALIDATION_FAILED` — the form or the options are wrong; `UNSUPPORTED_CONVERSION` — no such target, or not from this source; `INVALID_SOURCE` — empty, not UTF-8, or not valid in its format; `UNSAFE_SOURCE` — an SVG with scripts or external references; `IMAGE_TOO_LARGE` — over the pixel limits.',
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

    return attachment(reply, result);
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

    return attachment(reply, result);
  }
}
