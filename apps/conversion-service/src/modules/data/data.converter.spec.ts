import { ConfigService } from '@core/config/config.service';
import { AppError } from '@core/errors/app-error';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import type { ConversionConfig } from '../../config/conversion.config';
import {
  WorkerMemoryError,
  WorkerRunner,
  WorkerTimeoutError,
} from '../converters/worker-runner';
import { DataConverter } from './data.converter';
import { transform, type TransformRequest } from './data-transform';

describe('DataConverter', () => {
  const config = {
    getNumber: (key: string) =>
      ({ CONVERSION_MAX_DEPTH: 64, CONVERSION_WORKER_MEMORY_MB: 128 })[key],
  } as unknown as ConfigService<ConversionConfig>;

  let run: jest.Mock;
  let converter: DataConverter;

  beforeEach(() => {
    // The thread is WorkerRunner's business, tested there; here the work runs
    // inline, so what is checked is the converter around it.
    run = jest.fn((_entry: string, request: TransformRequest) =>
      Promise.resolve(transform(request)),
    );
    converter = new DataConverter({ run } as unknown as WorkerRunner, config);
  });

  const input = (text: string, source: string, target: string) => ({
    data: Buffer.from(text),
    source,
    target,
    timeoutMs: 1_000,
  });

  it('serves the four formats, each to the three others', () => {
    expect(converter.sourceFormats().map((format) => format.id)).toEqual([
      'json',
      'xml',
      'csv',
      'yaml',
    ]);
    expect(converter.targetsFor('csv')).toEqual(['json', 'xml', 'yaml']);
    expect(converter.targetsFor('pdf')).toEqual([]);
    expect(converter.describe('yaml')?.extensions).toEqual(['.yaml', '.yml']);
    expect(converter.describe('pdf')).toBeUndefined();
  });

  describe('detect', () => {
    it.each([
      ['data.CSV', 'csv'],
      ['data.yml', 'yaml'],
      ['data.yaml', 'yaml'],
      ['data.json', 'json'],
      ['data.xml', 'xml'],
    ])('by extension: %s → %s', (name, format) => {
      expect(converter.detect(name, Buffer.from('anything'))).toBe(format);
    });

    it('by content, for JSON and XML, when the name does not say', () => {
      expect(converter.detect('upload', Buffer.from('\n  {"a": 1}'))).toBe(
        'json',
      );
      expect(converter.detect('upload.txt', Buffer.from('<a/>'))).toBe('xml');
    });

    it('looks past a byte-order mark', () => {
      const head = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('[1]'),
      ]);

      expect(converter.detect('upload', head)).toBe('json');
    });

    it('does not guess CSV or YAML from content', () => {
      expect(converter.detect('upload', Buffer.from('a,b\n1,2\n'))).toBeNull();
    });
  });

  it('converts in a worker with the configured limits', async () => {
    const output = await converter.convert(input('[{"a":"1"}]', 'json', 'csv'));

    expect(output.data.toString()).toBe('a\r\n1\r\n');
    expect(output.mimeType).toBe('text/csv; charset=utf-8');
    expect(output.extension).toBe('csv');
    expect(run).toHaveBeenCalledWith(
      expect.stringMatching(/data-transform\.worker\.js$/),
      expect.objectContaining({ source: 'json', target: 'csv', maxDepth: 64 }),
      { timeoutMs: 1_000, maxMemoryMb: 128 },
    );
  });

  it('names the first extension of a format with several', async () => {
    const output = await converter.convert(input('[1]', 'json', 'yaml'));

    expect(output.extension).toBe('yaml');
  });

  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  };

  it('refuses a pair it does not do, before starting a thread', async () => {
    const error = await refusal(converter.convert(input('[]', 'json', 'json')));

    expect(error.code).toBe(ERROR_CODES.UNSUPPORTED_CONVERSION);
    expect(run).not.toHaveBeenCalled();
  });

  it('turns a file that does not parse into a 400 INVALID_SOURCE', async () => {
    const error = await refusal(converter.convert(input('{', 'json', 'xml')));

    expect(error).toMatchObject({
      code: ERROR_CODES.INVALID_SOURCE,
      httpStatus: 400,
    });
    expect(error.message).toMatch(/^Invalid JSON/);
  });

  it('turns the time limit into a 422 CONVERSION_TIMEOUT', async () => {
    run.mockRejectedValue(new WorkerTimeoutError(30_000));

    const error = await refusal(converter.convert(input('[]', 'json', 'xml')));

    expect(error).toMatchObject({
      code: ERROR_CODES.CONVERSION_TIMEOUT,
      httpStatus: 422,
    });
    expect(error.message).toMatch(/in the time allowed/);
  });

  it('turns the memory limit into a 413 FILE_TOO_LARGE', async () => {
    run.mockRejectedValue(new WorkerMemoryError());

    const error = await refusal(converter.convert(input('[]', 'json', 'xml')));

    expect(error).toMatchObject({
      code: ERROR_CODES.FILE_TOO_LARGE,
      httpStatus: 413,
    });
  });

  it('lets any other failure through as itself', async () => {
    run.mockRejectedValue(new Error('worker crashed'));

    await expect(converter.convert(input('[]', 'json', 'xml'))).rejects.toThrow(
      'worker crashed',
    );
  });
});
