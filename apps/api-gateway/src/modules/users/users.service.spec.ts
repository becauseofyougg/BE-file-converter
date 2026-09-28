import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';

import { USERS_PATTERNS } from '@contracts/messages/users.messages';
import type { StorageService } from '@storage/storage.service';

import { PROFILE_PHOTO_BUCKET, UsersService } from './users.service';

const VIEWER = 'viewer-1';

describe('gateway UsersService', () => {
  let send: jest.Mock;
  let presignGet: jest.Mock;
  let service: UsersService;

  beforeEach(() => {
    send = jest.fn().mockReturnValue(of({ id: 'user-1' }));
    presignGet = jest.fn().mockResolvedValue('https://signed.example/photo');

    service = new UsersService(
      { send } as unknown as ClientProxy,
      {
        presignGet,
      } as unknown as StorageService,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  const caller = { viewerUserId: VIEWER, viewerRoles: ['USER'] };

  describe('getProfile', () => {
    it('forwards to identity under the right pattern', async () => {
      await service.getProfile({ targetUserId: 'user-1', ...caller });

      expect(send).toHaveBeenCalledWith(
        USERS_PATTERNS.GET_PROFILE,
        expect.objectContaining({
          targetUserId: 'user-1',
          viewerUserId: VIEWER,
        }),
      );
    });

    /**
     * The whole reason the two field names differ: identity returns a storage
     * key, and the gateway is what turns it into a URL a browser can use.
     */
    it('swaps the storage key for a presigned URL', async () => {
      send.mockReturnValue(
        of({ id: 'user-1', photoKey: 'profile-photos/a.jpg' }),
      );

      await expect(
        service.getProfile({ targetUserId: 'user-1', ...caller }),
      ).resolves.toEqual({
        id: 'user-1',
        photo: 'https://signed.example/photo',
      });
      expect(presignGet).toHaveBeenCalledWith(
        PROFILE_PHOTO_BUCKET,
        'profile-photos/a.jpg',
      );
    });

    it('returns null when the account has no photo', async () => {
      send.mockReturnValue(of({ id: 'user-1', photoKey: null }));

      const profile = await service.getProfile({
        targetUserId: 'user-1',
        ...caller,
      });

      expect(profile.photo).toBeNull();
      expect(presignGet).not.toHaveBeenCalled();
    });

    /**
     * Withheld stays withheld: the field policy already decided, and a `photo:
     * null` here would turn "you may not see this" into "there isn't one".
     */
    it('adds no photo field when the policy withheld it', async () => {
      send.mockReturnValue(of({ id: 'user-1', email: 'a@b.c' }));

      const profile = await service.getProfile({
        targetUserId: 'user-1',
        ...caller,
      });

      expect('photo' in profile).toBe(false);
    });

    /** An account page should not go down over an avatar. */
    it('serves the profile without a photo when presigning fails', async () => {
      send.mockReturnValue(of({ id: 'user-1', photoKey: 'a.jpg' }));
      presignGet.mockRejectedValue(new Error('storage unreachable'));

      const profile = await service.getProfile({
        targetUserId: 'user-1',
        ...caller,
      });

      expect(profile).toEqual({ id: 'user-1', photo: null });
    });

    it('never leaks the storage key to the client', async () => {
      send.mockReturnValue(of({ id: 'user-1', photoKey: 'secret/key.jpg' }));

      const profile = await service.getProfile({
        targetUserId: 'user-1',
        ...caller,
      });

      expect(JSON.stringify(profile)).not.toContain('secret/key.jpg');
    });
  });

  describe('updateProfile', () => {
    it('forwards the patch and presigns the result', async () => {
      send.mockReturnValue(of({ id: 'user-1', photoKey: 'a.jpg' }));

      const profile = await service.updateProfile({
        targetUserId: 'user-1',
        ...caller,
        patch: { displayName: 'Ada' },
      });

      expect(send).toHaveBeenCalledWith(
        USERS_PATTERNS.UPDATE_PROFILE,
        expect.objectContaining({ patch: { displayName: 'Ada' } }),
      );
      expect(profile.photo).toBe('https://signed.example/photo');
    });
  });

  describe('listUsers', () => {
    it('presigns every item and keeps the cursor', async () => {
      send.mockReturnValue(
        of({
          items: [
            { id: 'a', photoKey: 'a.jpg' },
            { id: 'b', photoKey: null },
          ],
          nextCursor: 'next',
        }),
      );

      const page = await service.listUsers({ ...caller, limit: 2 });

      expect(page.items).toEqual([
        { id: 'a', photo: 'https://signed.example/photo' },
        { id: 'b', photo: null },
      ]);
      expect(page.nextCursor).toBe('next');
    });

    it('asks for nothing when the page is empty', async () => {
      send.mockReturnValue(of({ items: [], nextCursor: null }));

      await expect(service.listUsers({ ...caller })).resolves.toEqual({
        items: [],
        nextCursor: null,
      });
      expect(presignGet).not.toHaveBeenCalled();
    });
  });

  describe('the plain forwarders', () => {
    it.each([
      ['startEmailChange', USERS_PATTERNS.START_EMAIL_CHANGE],
      ['confirmEmailChange', USERS_PATTERNS.CONFIRM_EMAIL_CHANGE],
      ['deleteUser', USERS_PATTERNS.DELETE_USER],
      ['confirmDeletion', USERS_PATTERNS.CONFIRM_DELETION],
    ])('%s sends %s', async (method, pattern) => {
      await (
        service[method as 'deleteUser'] as (input: unknown) => Promise<unknown>
      )({ targetUserId: 'user-1', ...caller });

      expect(send).toHaveBeenCalledWith(pattern, expect.any(Object));
    });

    it('lets an identity refusal through rather than swallowing it', async () => {
      send.mockReturnValue(
        throwError(() => ({
          code: 'FORBIDDEN',
          message: 'Access denied',
          httpStatus: 403,
        })),
      );

      await expect(
        service.getProfile({ targetUserId: 'other', ...caller }),
      ).rejects.toMatchObject({ httpStatus: 403 });
    });
  });
});
