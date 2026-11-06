import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';

import type { RequestUser } from '../auth/request-user';
import {
  AdminTransformationsController,
  TransformationsController,
} from './transformations.controller';
import type { TransformationsService } from './transformations.service';

describe('transformation history controllers', () => {
  const caller: RequestUser = { id: 'user-1', roles: ['USER'], tokenId: 't' };
  const request = { headers: {}, id: 'req-1' } as unknown as FastifyRequest;
  const transformations = {
    history: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };

  it("serves the caller's own history", async () => {
    await new TransformationsController(
      transformations as unknown as TransformationsService,
    ).history({ status: 'success', limit: 10 }, caller, request);

    expect(transformations.history).toHaveBeenLastCalledWith(
      caller,
      { kind: 'self' },
      { status: 'success', limit: 10 },
      'req-1',
    );
  });

  describe('one item, and its saved file', () => {
    const result = {
      file: {
        bucket: 'results' as const,
        key: 'k',
        driver: 'local',
        contentType: 'application/json; charset=utf-8',
        fileName: 'people.json',
        size: 2,
        fileId: 'file-1',
      },
      stream: Readable.from(['{}']),
      operationId: 'item-1',
    };
    const service = {
      operation: jest.fn().mockResolvedValue({ id: 'item-1' }),
      download: jest.fn().mockResolvedValue(result),
    };
    const reply = { header: jest.fn() } as unknown as FastifyReply;

    it("reads the caller's own item", async () => {
      await new TransformationsController(
        service as unknown as TransformationsService,
      ).operation({ itemId: 'item-1' }, caller, request);

      expect(service.operation).toHaveBeenCalledWith(caller, 'item-1', 'req-1');
    });

    it("downloads the caller's own file, named after the upload", async () => {
      const file = await new TransformationsController(
        service as unknown as TransformationsService,
      ).download({ itemId: 'item-1' }, caller, request, reply);

      expect(service.download).toHaveBeenLastCalledWith(
        caller,
        { kind: 'self' },
        'item-1',
        'req-1',
      );
      expect(file.getHeaders().disposition).toBe(
        'attachment; filename="people.json"',
      );
    });

    it("downloads another user's file, for the ids in the path", async () => {
      await new AdminTransformationsController(
        service as unknown as TransformationsService,
      ).download(
        { userId: 'target-1', itemId: 'item-1' },
        caller,
        request,
        reply,
      );

      expect(service.download).toHaveBeenLastCalledWith(
        caller,
        { kind: 'admin', targetUserId: 'target-1' },
        'item-1',
        'req-1',
      );
    });
  });

  it("serves another user's history, for the id in the path", async () => {
    await new AdminTransformationsController(
      transformations as unknown as TransformationsService,
    ).history({ userId: 'target-1' }, { type: 'image' }, caller, request);

    expect(transformations.history).toHaveBeenLastCalledWith(
      caller,
      { kind: 'admin', targetUserId: 'target-1' },
      { type: 'image' },
      'req-1',
    );
  });
});
