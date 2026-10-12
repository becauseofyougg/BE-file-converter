import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma-clients/conversion';

import { AppError } from '@core/errors/app-error';
import { FormatFamily } from '@contracts/enums/conversion.enums';
import {
  CONVERSION_HISTORY_LIMITS,
  type TransformationHistoryPage,
  type TransformationHistoryRequest,
} from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { ConverterRegistry } from '../converters/converter-registry';
import {
  decodeCursor,
  encodeCursor,
  HISTORY_ITEM_SELECT,
  toHistoryItem,
} from './operation-record';

/**
 * One user's finished transformations, newest first — docs/TRANSFORMATION-HISTORY.md.
 *
 * Whose history it is was settled by the gateway (self, or a holder of
 * `transformations@read`); this answers for whatever `userId` it is given.
 *
 * - **Finished only.** An operation still `PROCESSING` is not history yet,
 *   and has no status the spec can name.
 * - **Cursor paging** on `(created_at, id)`, as before: the same request
 *   returns the same page, and a conversion finishing meanwhile does not shift
 *   a later page by one. The cursor marks a position, not a filter, so it
 *   stays valid if the filters change.
 * - **Filters are checked, not passed through.** A format no converter knows
 *   is a 400 naming what is known, not an empty page that looks like "no
 *   history".
 */
@Injectable()
export class TransformationHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConverterRegistry,
  ) {}

  async list(
    request: TransformationHistoryRequest,
  ): Promise<TransformationHistoryPage> {
    const limit = Math.min(
      Math.max(request.limit ?? CONVERSION_HISTORY_LIMITS.default, 1),
      CONVERSION_HISTORY_LIMITS.max,
    );
    const where = this.filters(request);
    const cursor = request.cursor ? decodeCursor(request.cursor) : null;

    if (request.cursor && !cursor) {
      throw invalid(['cursor is not one this service issued']);
    }

    const rows = await this.prisma.conversionOperation.findMany({
      where: cursor
        ? {
            AND: [
              where,
              {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: HISTORY_ITEM_SELECT,
    });

    const page = rows.slice(0, limit);

    return {
      items: page.map(toHistoryItem),
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  private filters(
    request: TransformationHistoryRequest,
  ): Prisma.ConversionOperationWhereInput {
    const errors: string[] = [];
    const known = this.registry.knownFormats();

    for (const name of ['sourceFormat', 'targetFormat'] as const) {
      const value = request[name];

      if (value !== undefined && !known.includes(value)) {
        errors.push(`${name} must be one of: ${known.join(', ')}`);
      }
    }

    const from = date(request.createdAtFrom, 'createdAtFrom', errors);
    const to = date(request.createdAtTo, 'createdAtTo', errors);

    if (from && to && from > to) {
      errors.push('createdAtFrom must not be after createdAtTo');
    }

    if (errors.length > 0) {
      throw invalid(errors);
    }

    return {
      userId: request.userId,
      status:
        request.status === 'success'
          ? 'COMPLETED'
          : request.status === 'error'
            ? 'FAILED'
            : { in: ['COMPLETED', 'FAILED'] },
      ...(request.type === 'image'
        ? { family: FormatFamily.IMAGE }
        : request.type === 'file'
          ? { family: { not: FormatFamily.IMAGE } }
          : {}),
      ...(request.sourceFormat ? { sourceFormat: request.sourceFormat } : {}),
      ...(request.targetFormat ? { targetFormat: request.targetFormat } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };
  }
}

function date(
  value: string | undefined,
  name: string,
  errors: string[],
): Date | null {
  if (value === undefined) {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    errors.push(`${name} must be an ISO 8601 date-time`);

    return null;
  }

  return parsed;
}

function invalid(errors: string[]): AppError {
  return new AppError(
    ERROR_CODES.VALIDATION_FAILED,
    'The history query is not valid',
    400,
    { errors },
  );
}
