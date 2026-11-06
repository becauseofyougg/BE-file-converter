import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

import type { RequestUser } from '../auth/request-user';
import { CONVERSION_ID_HEADER } from './attachment';
import type { ConversionsService } from './conversions.service';
import { IMAGE_ROUTE, ImagesController } from './images.controller';

describe('ImagesController', () => {
  const user: RequestUser = { id: 'user-1', roles: ['USER'], tokenId: 't' };
  const request = { headers: {}, id: 'req-1' } as unknown as FastifyRequest;
  const result = {
    file: {
      bucket: 'results' as const,
      key: 'k',
      driver: 'local',
      contentType: 'image/png',
      fileName: 'converted.png',
      size: 8,
    },
    stream: Readable.from([Buffer.alloc(8)]),
    operationId: 'op-1',
  };

  const conversions = {
    convert: jest.fn().mockResolvedValue(result),
    formats: jest.fn().mockResolvedValue([]),
  };
  const controller = new ImagesController(
    conversions as unknown as ConversionsService,
  );

  it('converts as the caller, held to images, with the options as fields', async () => {
    const header = jest.fn();
    const file = await controller.convert(request, user, {
      header,
    } as unknown as FastifyReply);

    expect(conversions.convert).toHaveBeenCalledWith(
      request,
      'user-1',
      'req-1',
      IMAGE_ROUTE,
    );
    expect(IMAGE_ROUTE).toEqual({
      family: 'image',
      flatOptions: ['quality', 'width', 'height', 'background'],
    });
    expect(file.getHeaders()).toEqual({
      type: 'image/png',
      disposition: 'attachment; filename="converted.png"',
      length: 8,
    });
    expect(header).toHaveBeenCalledWith(CONVERSION_ID_HEADER, 'op-1');
  });

  it('lists the image directions only', async () => {
    await controller.formats(request);

    expect(conversions.formats).toHaveBeenCalledWith('req-1', 'image');
  });
});
