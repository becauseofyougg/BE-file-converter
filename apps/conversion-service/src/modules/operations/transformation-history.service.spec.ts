import type { ConversionOperation } from '@prisma-clients/conversion';

import { AppError } from '@core/errors/app-error';
import type { TransformationHistoryRequest } from '@contracts/messages/conversion.messages';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { PrismaService } from '../../database/prisma.service';
import type { ConverterRegistry } from '../converters/converter-registry';
import { encodeCursor, HISTORY_ITEM_SELECT } from './operation-record';
import { TransformationHistoryService } from './transformation-history.service';

const USER = '0b6c3c6e-55d4-4f5e-8f2a-6a4c1d2e3f40';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

const row = (
  id: string,
  createdAt: string,
  overrides: Partial<ConversionOperation> = {},
) =>
  ({
    id,
    userId: USER,
    status: 'COMPLETED',
    family: 'data',
    sourceName: 'private-payroll.csv',
    sourceFormat: 'csv',
    sourceSize: BigInt(1234),
    sourceChecksum: 'a'.repeat(64),
    targetFormat: 'json',
    resultSize: BigInt(5),
    resultChecksum: 'b'.repeat(64),
    resultKey: null,
    storageDriver: 'local',
    options: null,
    fileId: null,
    saved: false,
    resultExpiresAt: null,
    errorCode: null,
    errorMessage: null,
    durationMs: 41,
    correlationId: 'c',
    createdAt: new Date(createdAt),
    finishedAt: new Date(createdAt),
    ...overrides,
  }) as ConversionOperation;

describe('TransformationHistoryService', () => {
  let findMany: jest.Mock;
  let service: TransformationHistoryService;

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    service = new TransformationHistoryService(
      { conversionOperation: { findMany } } as unknown as PrismaService,
      {
        knownFormats: () => [
          'csv',
          'jpeg',
          'json',
          'png',
          'svg',
          'xml',
          'yaml',
        ],
      } as unknown as ConverterRegistry,
    );
  });

  const list = (request: Partial<TransformationHistoryRequest> = {}) =>
    service.list({ userId: USER, ...request });

  const where = () =>
    findMany.mock.calls[0][0].where as Record<string, unknown>;

  async function refusal(
    request: Partial<TransformationHistoryRequest>,
  ): Promise<string[]> {
    const error = await list(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: ERROR_CODES.VALIDATION_FAILED,
      httpStatus: 400,
    });

    return (error as AppError & { details: { errors: string[] } }).details
      .errors;
  }

  it('returns items in the shape the spec fixes, and nothing personal', async () => {
    findMany.mockResolvedValue([
      row(B, '2026-10-02T11:00:00Z'),
      row(A, '2026-10-02T10:00:00Z', {
        status: 'FAILED',
        family: 'image',
        sourceFormat: null,
        targetFormat: 'png',
        errorCode: 'UNSUPPORTED_FORMAT',
        errorMessage: 'The file is not in a format this service reads',
        durationMs: null,
      }),
    ]);

    const page = await list();

    expect(page).toEqual({
      items: [
        {
          id: B,
          type: 'file',
          sourceFormat: 'csv',
          targetFormat: 'json',
          status: 'success',
          fileSize: 1234,
          durationMs: 41,
          fileId: null,
          createdAt: '2026-10-02T11:00:00.000Z',
        },
        {
          id: A,
          type: 'image',
          sourceFormat: null,
          targetFormat: 'png',
          status: 'error',
          fileSize: 1234,
          durationMs: 0,
          errorCode: 'UNSUPPORTED_FORMAT',
          fileId: null,
          createdAt: '2026-10-02T10:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(page)).not.toMatch(/payroll|aaaa|bbbb/);
  });

  it('names a saved file while it can be downloaded, and only then', async () => {
    const FILE = '11111111-1111-4111-8111-111111111111';
    const later = new Date(Date.now() + 60_000);
    const earlier = new Date(Date.now() - 60_000);

    findMany.mockResolvedValue([
      row(A, '2026-10-02T10:00:00Z', {
        saved: true,
        fileId: FILE,
        resultKey: 'u/a.json',
        resultExpiresAt: later,
      }),
      row(B, '2026-10-02T09:00:00Z', {
        saved: true,
        fileId: FILE,
        resultKey: 'u/b.json',
        resultExpiresAt: earlier,
      }),
      row(C, '2026-10-02T08:00:00Z', {
        saved: true,
        fileId: FILE,
        resultKey: null,
      }),
    ]);

    expect((await list()).items.map((item) => item.fileId)).toEqual([
      FILE,
      null,
      null,
    ]);
  });

  it("asks only for the user's finished operations, newest first", async () => {
    await list();

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: USER, status: { in: ['COMPLETED', 'FAILED'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
      select: HISTORY_ITEM_SELECT,
    });
  });

  /** A page is up to a hundred rows: none of what an item leaves out is read. */
  it('reads only the columns an item is built from', async () => {
    await list();

    const columns = Object.keys(
      findMany.mock.calls[0][0].select as Record<string, true>,
    );

    for (const left of [
      'sourceName',
      'sourceChecksum',
      'resultChecksum',
      'options',
      'storageDriver',
      'errorMessage',
      'correlationId',
    ]) {
      expect(columns).not.toContain(left);
    }
  });

  it('pages with a cursor at the last item', async () => {
    findMany.mockResolvedValue([
      row(C, '2026-10-02T12:00:00Z'),
      row(B, '2026-10-02T11:00:00Z'),
      row(A, '2026-10-02T10:00:00Z'),
    ]);

    const page = await list({ limit: 2 });

    expect(page.items.map((item) => item.id)).toEqual([C, B]);
    expect(page.nextCursor).toBe(
      encodeCursor({ createdAt: new Date('2026-10-02T11:00:00Z'), id: B }),
    );
  });

  it('continues after the cursor, with the filters still applied', async () => {
    const at = new Date('2026-10-02T11:00:00Z');

    await list({
      cursor: encodeCursor({ createdAt: at, id: B }),
      status: 'error',
    });

    expect(where()).toEqual({
      AND: [
        { userId: USER, status: 'FAILED' },
        {
          OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: B } }],
        },
      ],
    });
  });

  it('clamps the page size', async () => {
    await list({ limit: 10_000 });
    await list({ limit: 0 });

    expect(findMany.mock.calls.map((call) => call[0].take)).toEqual([101, 2]);
  });

  describe('filters', () => {
    it.each([
      [{ status: 'success' as const }, { status: 'COMPLETED' }],
      [{ status: 'error' as const }, { status: 'FAILED' }],
      [{ type: 'image' as const }, { family: 'image' }],
      [{ type: 'file' as const }, { family: { not: 'image' } }],
      [{ sourceFormat: 'svg' }, { sourceFormat: 'svg' }],
      [{ targetFormat: 'yaml' }, { targetFormat: 'yaml' }],
    ])('%j', async (filter, expected) => {
      await list(filter);

      expect(where()).toMatchObject(expected);
    });

    it('a period, inclusive at both ends', async () => {
      await list({
        createdAtFrom: '2026-10-01T00:00:00Z',
        createdAtTo: '2026-10-31T23:59:59Z',
      });

      expect(where()).toMatchObject({
        createdAt: {
          gte: new Date('2026-10-01T00:00:00Z'),
          lte: new Date('2026-10-31T23:59:59Z'),
        },
      });
    });

    it('either end of a period alone', async () => {
      await list({ createdAtFrom: '2026-10-01T00:00:00Z' });

      expect(where()).toMatchObject({
        createdAt: { gte: new Date('2026-10-01T00:00:00Z') },
      });
      expect(where().createdAt).not.toHaveProperty('lte');
    });

    it('all of them at once', async () => {
      await list({
        type: 'image',
        sourceFormat: 'svg',
        targetFormat: 'png',
        status: 'success',
        createdAtTo: '2026-10-31T00:00:00Z',
      });

      expect(where()).toEqual({
        userId: USER,
        status: 'COMPLETED',
        family: 'image',
        sourceFormat: 'svg',
        targetFormat: 'png',
        createdAt: { lte: new Date('2026-10-31T00:00:00Z') },
      });
    });
  });

  describe('refusals', () => {
    it('a format no converter knows, naming the known ones', async () => {
      expect(
        await refusal({ sourceFormat: 'toml', targetFormat: 'pdf' }),
      ).toEqual([
        'sourceFormat must be one of: csv, jpeg, json, png, svg, xml, yaml',
        'targetFormat must be one of: csv, jpeg, json, png, svg, xml, yaml',
      ]);
    });

    it('a period that ends before it starts', async () => {
      expect(
        await refusal({
          createdAtFrom: '2026-10-02T00:00:00Z',
          createdAtTo: '2026-10-01T00:00:00Z',
        }),
      ).toEqual(['createdAtFrom must not be after createdAtTo']);
    });

    it('a date that is not one', async () => {
      expect(await refusal({ createdAtTo: 'yesterday' })).toEqual([
        'createdAtTo must be an ISO 8601 date-time',
      ]);
    });

    it('a cursor it did not issue', async () => {
      expect(await refusal({ cursor: 'garbage' })).toEqual([
        'cursor is not one this service issued',
      ]);
      expect(findMany).not.toHaveBeenCalled();
    });
  });
});
