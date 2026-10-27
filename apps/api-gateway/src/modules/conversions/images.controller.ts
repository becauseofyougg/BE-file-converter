import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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

import { FormatFamily } from '@contracts/enums/conversion.enums';
import type { ConversionFormatEntry } from '@contracts/messages/conversion.messages';
import { correlationIdFor } from '@core/messaging/correlation-id';
import { CurrentUser, type RequestUser } from '../auth/request-user';
import { ErrorResponseDto } from '../shared/api-responses.dto';
import { attachment } from './attachment';
import type { ConvertRoute } from './convert-fields';
import { ConversionsService } from './conversions.service';
import { ConversionFormatEntryDto } from './dto/conversions.dto';

const MINUTE_MS = 60_000;

/** What this route is: images only, and the options as separate fields too. */
export const IMAGE_ROUTE: ConvertRoute = {
  family: FormatFamily.IMAGE,
  flatOptions: ['quality', 'width', 'height', 'background'],
};

/**
 * docs/IMAGES.md. The images' own route, over the same pipeline as
 * `/api/convert`: one history, one `save`, one storage. What it adds is the
 * scope — a CSV sent here is a `415`, not a conversion — and the options as
 * plain form fields, which is what a form or `curl -F` sends most easily.
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
@Controller('api/images/convert')
export class ImagesController {
  constructor(private readonly conversions: ConversionsService) {}

  @ApiOperation({
    summary: 'Convert an image',
    description: [
      'PNG → JPEG, JPEG → PNG, SVG → PNG or JPEG. Nothing is converted to SVG.',
      '',
      'Options go either in `options` as a JSON object or as separate fields — not both:',
      '- `quality` 1–100, for a JPEG result (default 80);',
      '- `width`, `height`, for an SVG source: one scales the other; both fit the drawing inside, centred;',
      '- `background` `#rrggbb` (or `transparent` for PNG), for an SVG source or PNG → JPEG (default `#ffffff`).',
      '',
      'An option that does not apply to the direction is refused, not ignored. The result is in the',
      'history like any other conversion. The rules are in docs/IMAGES.md.',
    ].join('\n'),
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'targetFormat'],
      properties: {
        file: { type: 'string', format: 'binary' },
        targetFormat: { type: 'string', enum: ['png', 'jpeg', 'svg'] },
        save: { type: 'boolean', default: false },
        quality: { type: 'integer', minimum: 1, maximum: 100 },
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
        background: { type: 'string', example: '#ffffff' },
        options: {
          type: 'string',
          example: '{"width":512,"background":"#ffffff"}',
          description:
            'The same options as one JSON object, instead of the fields above.',
        },
      },
    },
  })
  @ApiProduces('image/png', 'image/jpeg')
  @ApiResponse({
    status: 200,
    description:
      'The image, as `attachment; filename="converted.<ext>"`. `X-Conversion-Id` names the history entry; `X-Result-Saved` says whether the result was kept (with `save=true`, `false` only when it is larger than saved files may be).',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiResponse({
    status: 400,
    description:
      '`VALIDATION_FAILED` — the form or an option is wrong; `UNSUPPORTED_CONVERSION` — not that direction (anything → svg); `INVALID_SOURCE` — not a valid image of its format; `UNSAFE_SOURCE` — an SVG with scripts or external references; `IMAGE_TOO_LARGE` — over the pixel or size limits.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 413,
    description: '`FILE_TOO_LARGE` — over the limit for its format.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 415,
    description: '`UNSUPPORTED_FORMAT` — not a PNG, JPEG or SVG.',
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
      IMAGE_ROUTE,
    );

    return attachment(reply, result);
  }

  @ApiOperation({
    summary: 'What images convert to what',
    description:
      'The image directions only; `GET /api/convert/formats` has them all.',
  })
  @ApiResponse({ status: 200, type: [ConversionFormatEntryDto] })
  @Get('formats')
  @Throttle({ default: { limit: 120, ttl: MINUTE_MS } })
  formats(@Req() request: FastifyRequest): Promise<ConversionFormatEntry[]> {
    return this.conversions.formats(
      correlationIdFor(request),
      FormatFamily.IMAGE,
    );
  }
}
