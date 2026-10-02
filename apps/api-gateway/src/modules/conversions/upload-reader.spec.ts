import type { FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

import { AppError } from '@core/errors/app-error';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { readUpload } from './upload-reader';

type Part =
  | { type: 'field'; fieldname: string; value: unknown }
  | {
      type: 'file';
      fieldname: string;
      filename: string;
      file: Readable & { truncated?: boolean };
    };

const field = (fieldname: string, value: unknown): Part => ({
  type: 'field',
  fieldname,
  value,
});

const file = (
  content: string | Error,
  fieldname = 'file',
  filename = 'a.csv',
): Part => {
  const stream =
    content instanceof Error
      ? new Readable({
          read() {
            this.destroy(content);
          },
        })
      : Readable.from([Buffer.from(content)]);

  return { type: 'file', fieldname, filename, file: stream };
};

const requestOf = (parts: Part[], multipart = true) =>
  ({
    isMultipart: () => multipart,
    parts: async function* () {
      for (const part of parts) {
        yield await Promise.resolve(part);
      }
    },
  }) as unknown as FastifyRequest;

/** A `store` that reads what it is given to the end, as storage does. */
const collect = () => {
  const written: Buffer[] = [];

  const store = async (body: Readable) => {
    for await (const chunk of body) {
      written.push(chunk as Buffer);
    }
  };

  return { store, written: () => Buffer.concat(written).toString() };
};

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(AppError);

  return error as AppError;
}

describe('readUpload', () => {
  it('stores the file as it streams, counting it, and collects the fields', async () => {
    const { store, written } = collect();

    const upload = await readUpload(
      requestOf([
        field('targetFormat', 'json'),
        file('id\r\n1\r\n'),
        field('save', 'true'),
      ]),
      store,
      1024,
    );

    expect(upload).toEqual({
      fileName: 'a.csv',
      size: 7,
      fields: { targetFormat: 'json', save: 'true' },
    });
    expect(written()).toBe('id\r\n1\r\n');
  });

  it('turns a non-string field value into text', async () => {
    const { store } = collect();

    const upload = await readUpload(
      requestOf([file('x'), field('save', true)]),
      store,
      1024,
    );

    expect(upload.fields.save).toBe('true');
  });

  it('refuses a request that is not multipart', async () => {
    const error = await refusal(
      readUpload(requestOf([], false), collect().store, 1024),
    );

    expect(error).toMatchObject({
      code: ERROR_CODES.VALIDATION_FAILED,
      httpStatus: 400,
    });
  });

  it('refuses a request with no file', async () => {
    const error = await refusal(
      readUpload(
        requestOf([field('targetFormat', 'json')]),
        collect().store,
        1024,
      ),
    );

    expect(error.message).toMatch(/part named "file"/);
  });

  it('refuses a file under another name, or a second one', async () => {
    await refusal(
      readUpload(requestOf([file('x', 'upload')]), collect().store, 1024),
    );
    await refusal(
      readUpload(requestOf([file('x'), file('y')]), collect().store, 1024),
    );
  });

  it('turns the size limit, mid-stream, into a 413', async () => {
    const tooLarge = Object.assign(new Error('too large'), {
      code: 'FST_REQ_FILE_TOO_LARGE',
    });

    const error = await refusal(
      readUpload(requestOf([file(tooLarge)]), collect().store, 1024),
    );

    expect(error).toMatchObject({
      code: ERROR_CODES.FILE_TOO_LARGE,
      httpStatus: 413,
      details: { maxBytes: 1024 },
    });
  });

  it('treats a truncated file as too large too', async () => {
    const part = file('partial') as Extract<Part, { type: 'file' }>;

    part.file.truncated = true;

    const error = await refusal(
      readUpload(requestOf([part]), collect().store, 4),
    );

    expect(error.code).toBe(ERROR_CODES.FILE_TOO_LARGE);
  });

  it.each(['FST_FILES_LIMIT', 'FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT'])(
    'turns %s into a 400',
    async (code) => {
      const request = {
        isMultipart: () => true,
        // eslint-disable-next-line require-yield
        parts: async function* () {
          await Promise.resolve();
          throw Object.assign(new Error('limit'), { code });
        },
      } as unknown as FastifyRequest;

      const error = await refusal(readUpload(request, collect().store, 1024));

      expect(error.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    },
  );

  it('lets any other failure through', async () => {
    const store = () => Promise.reject(new Error('storage down'));

    await expect(
      readUpload(requestOf([file('x')]), store, 1024),
    ).rejects.toThrow('storage down');
  });
});
