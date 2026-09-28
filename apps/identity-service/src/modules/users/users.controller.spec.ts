import type { RmqContext } from '@nestjs/microservices';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { AppError } from '@core/errors/app-error';

import type { AccountDeletionService } from './account-deletion.service';
import type { EmailChangeService } from './email-change.service';
import type { ProfileUpdateService } from './profile-update.service';
import type { ProfileService } from './profile.service';
import type { UserListService } from './user-list.service';
import { UsersController } from './users.controller';

const VIEWER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';

describe('identity UsersController', () => {
  let profiles: jest.Mocked<ProfileService>;
  let updates: jest.Mocked<ProfileUpdateService>;
  let emailChange: jest.Mocked<EmailChangeService>;
  let deletion: jest.Mocked<AccountDeletionService>;
  let list: jest.Mocked<UserListService>;
  let ack: jest.Mock;
  let context: RmqContext;
  let controller: UsersController;

  const message = { fields: { deliveryTag: 1 } };
  const caller = { viewerUserId: VIEWER, viewerRoles: ['USER'] };

  beforeEach(() => {
    profiles = {
      getProfile: jest.fn().mockResolvedValue({ id: TARGET }),
    } as unknown as jest.Mocked<ProfileService>;

    updates = {
      updateProfile: jest.fn().mockResolvedValue({ id: TARGET }),
    } as unknown as jest.Mocked<ProfileUpdateService>;

    emailChange = {
      start: jest.fn().mockResolvedValue({ requiresConfirmation: true }),
      confirm: jest.fn().mockResolvedValue({ status: 'email_changed' }),
    } as unknown as jest.Mocked<EmailChangeService>;

    deletion = {
      requestDeletion: jest.fn().mockResolvedValue({ status: 'deleted' }),
      confirmDeletion: jest.fn().mockResolvedValue({ status: 'deleted' }),
    } as unknown as jest.Mocked<AccountDeletionService>;

    list = {
      listUsers: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    } as unknown as jest.Mocked<UserListService>;

    ack = jest.fn();
    context = {
      getChannelRef: () => ({ ack }),
      getMessage: () => message,
    } as unknown as RmqContext;

    controller = new UsersController(
      profiles,
      updates,
      emailChange,
      deletion,
      list,
    );
  });

  it('dispatches a profile read', async () => {
    await controller.getProfile(
      { targetUserId: TARGET, ...caller, correlationId: 'c' },
      context,
    );

    expect(profiles.getProfile).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: TARGET, viewerUserId: VIEWER }),
    );
    expect(ack).toHaveBeenCalledWith(message);
  });

  it('dispatches a patch with its field set intact', async () => {
    await controller.updateProfile(
      {
        targetUserId: TARGET,
        ...caller,
        patch: { displayName: 'Ada' },
        correlationId: 'c',
      },
      context,
    );

    expect(updates.updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { displayName: 'Ada' } }),
    );
  });

  it('dispatches the two halves of an email change', async () => {
    await controller.startEmailChange(
      {
        targetUserId: VIEWER,
        viewerUserId: VIEWER,
        newEmail: 'new@example.com',
      },
      context,
    );
    expect(emailChange.start).toHaveBeenCalled();

    await controller.confirmEmailChange(
      { targetUserId: VIEWER, challengeId: 'c', code: '123456' },
      context,
    );
    expect(emailChange.confirm).toHaveBeenCalled();
  });

  it('dispatches the two halves of an erasure', async () => {
    await controller.deleteUser(
      { targetUserId: TARGET, ...caller, reason: 'support' },
      context,
    );
    expect(deletion.requestDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'support' }),
    );

    await controller.confirmDeletion(
      {
        targetUserId: VIEWER,
        viewerUserId: VIEWER,
        challengeId: 'c',
        code: '123456',
      },
      context,
    );
    expect(deletion.confirmDeletion).toHaveBeenCalled();
  });

  it('dispatches a list with every filter it was given', async () => {
    await controller.listUsers(
      {
        ...caller,
        cursor: 'abc',
        limit: 50,
        q: 'ada',
        status: 'locked',
        sort: 'last_login',
        order: 'asc',
      },
      context,
    );

    expect(list.listUsers).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: 'abc',
        limit: 50,
        q: 'ada',
        status: 'locked',
        sort: 'last_login',
        order: 'asc',
      }),
    );
  });

  describe('acking', () => {
    it('acks a business refusal', async () => {
      profiles.getProfile.mockRejectedValue(
        new AppError(ERROR_CODES.FORBIDDEN, 'Access denied', 403),
      );

      await expect(
        controller.getProfile({ targetUserId: TARGET, ...caller }, context),
      ).rejects.toThrow(AppError);
      expect(ack).toHaveBeenCalledWith(message);
    });

    it('leaves a crash for the broker to redeliver', async () => {
      profiles.getProfile.mockRejectedValue(new Error('database gone'));

      await expect(
        controller.getProfile({ targetUserId: TARGET, ...caller }, context),
      ).rejects.toThrow('database gone');
      expect(ack).not.toHaveBeenCalled();
    });
  });
});
