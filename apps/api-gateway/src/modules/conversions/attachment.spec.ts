import type { FastifyReply } from 'fastify';
import { Readable } from 'node:stream';

import {
  attachment,
  CONVERSION_ID_HEADER,
  contentDisposition,
  RESULT_SAVED_HEADER,
} from './attachment';

describe('contentDisposition', () => {
  it('names an ASCII file plainly', () => {
    expect(contentDisposition('people.json')).toBe(
      'attachment; filename="people.json"',
    );
  });

  it('gives a non-ASCII name an ASCII fallback and the exact name as filename*', () => {
    expect(contentDisposition('отчёт 2026.json')).toBe(
      `attachment; filename="_____ 2026.json"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%202026.json`,
    );
  });

  /** Whatever the name holds, it cannot end the header value or start a new header. */
  it.each([
    ['a"b.json', 'attachment; filename="a_b.json"'],
    ['a\\b.json', 'attachment; filename="a_b.json"'],
    ['a\r\nSet-Cookie: x.json', 'attachment; filename="a__Set-Cookie: x.json"'],
  ])('keeps %j out of the header', (name, plain) => {
    expect(contentDisposition(name).startsWith(plain)).toBe(true);
    expect(contentDisposition(name)).not.toMatch(/[\r\n]/);
  });

  it('escapes what RFC 5987 does not allow raw in filename*', () => {
    expect(contentDisposition("é's (1)*.png")).toContain(
      "filename*=UTF-8''%C3%A9%27s%20%281%29%2A.png",
    );
  });
});

describe('attachment', () => {
  const file = {
    bucket: 'results' as const,
    key: 'k',
    driver: 'local',
    contentType: 'image/png',
    fileName: 'logo.png',
    size: 4,
  };

  const replyWith = () => {
    const header = jest.fn();

    return { header, reply: { header } as unknown as FastifyReply };
  };

  it('sets the id, and whether the result was kept when that is known', () => {
    const { header, reply } = replyWith();

    attachment(reply, {
      file,
      stream: Readable.from([]),
      operationId: 'op',
      saved: false,
    });

    expect(header).toHaveBeenCalledWith(CONVERSION_ID_HEADER, 'op');
    expect(header).toHaveBeenCalledWith(RESULT_SAVED_HEADER, 'false');
  });

  it('leaves the saved header off a download', () => {
    const { header, reply } = replyWith();

    const streamable = attachment(reply, {
      file,
      stream: Readable.from([]),
      operationId: 'op',
    });

    expect(header).toHaveBeenCalledTimes(1);
    expect(streamable.getHeaders()).toEqual({
      type: 'image/png',
      disposition: 'attachment; filename="logo.png"',
      length: 4,
    });
  });
});
