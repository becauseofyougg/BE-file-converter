import type { FastifyRequest } from 'fastify';

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
