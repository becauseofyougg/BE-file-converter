import type { StreamableFile } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

import type { RequestUser } from '../auth/request-user';
import { CONVERSION_ID_HEADER } from './attachment';
import { ConversionsController } from './conversions.controller';
import type { ConversionsService } from './conversions.service';

describe('ConversionsController', () => {
  const user: RequestUser = { id: 'user-1', roles: ['USER'], tokenId: 't' };
  const request = { headers: {}, id: 'req-1' } as unknown as FastifyRequest;
  const result = {
    file: {
      bucket: 'results' as const,
      key: 'k',
      driver: 'local',
      contentType: 'text/csv; charset=utf-8',
      fileName: 'converted.csv',
      size: 3,
    },
    stream: Readable.from(['a\r\n']),
    operationId: 'op-1',
  };

  const conversions = {
    convert: jest.fn().mockResolvedValue(result),
    formats: jest.fn().mockResolvedValue([]),
  };
  const controller = new ConversionsController(
    conversions as unknown as ConversionsService,
  );

  let header: jest.Mock;
  let reply: FastifyReply;

  beforeEach(() => {
    header = jest.fn();
    reply = { header } as unknown as FastifyReply;
  });

  const expectAttachment = (file: StreamableFile) => {
    expect(file.getHeaders()).toEqual({
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="converted.csv"',
      length: 3,
    });
    expect(header).toHaveBeenCalledWith(CONVERSION_ID_HEADER, 'op-1');
  };

  it('converts as the caller, and sends the result as an attachment', async () => {
    const file = await controller.convert(request, user, reply);

    expect(conversions.convert).toHaveBeenCalledWith(
      request,
      'user-1',
      'req-1',
    );
    expectAttachment(file);
  });

  it('lists the formats', async () => {
    await expect(controller.formats(request)).resolves.toEqual([]);
  });
});
