import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/jwt-auth.guard';
import type { SessionCookiesService } from '../auth/session-cookies.service';
import { UsersController } from './users.controller';
import type { UsersService } from './users.service';

const SELF: RequestUser = { id: 'user-1', roles: ['USER'], tokenId: 'jti-1' };
const OTHER = 'user-2';

describe('gateway UsersController', () => {
  let users: jest.Mocked<UsersService>;
  let cookies: jest.Mocked<SessionCookiesService>;
  let reply: { status: jest.Mock };
  let controller: UsersController;

  const request = {
    headers: {},
    id: 'req-1',
  } as unknown as FastifyRequest;

  beforeEach(() => {
    users = {
      getProfile: jest.fn().mockResolvedValue({ id: 'user-1' }),
      updateProfile: jest.fn().mockResolvedValue({ id: 'user-1' }),
      startEmailChange: jest
        .fn()
        .mockResolvedValue({ requiresConfirmation: true }),
      confirmEmailChange: jest
        .fn()
        .mockResolvedValue({ status: 'email_changed' }),
      deleteUser: jest.fn().mockResolvedValue({ status: 'deleted' }),
      confirmDeletion: jest.fn().mockResolvedValue({ status: 'deleted' }),
    } as unknown as jest.Mocked<UsersService>;

    cookies = {
      clear: jest.fn(),
    } as unknown as jest.Mocked<SessionCookiesService>;

    reply = { status: jest.fn().mockReturnThis() };
    controller = new UsersController(users, cookies);
  });

  const asReply = () => reply as unknown as FastifyReply;

  /**
   * The load-bearing property of every route here: the viewer comes from the
   * verified token, never from the URL or the body. That is the whole of the
   * IDOR defence.
   */
  describe('the viewer always comes from the token', () => {
    it('on a read', async () => {
      await controller.getProfile({ userId: OTHER }, SELF, request);

      expect(users.getProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          targetUserId: OTHER,
          viewerUserId: SELF.id,
          viewerRoles: SELF.roles,
        }),
      );
    });

    it('on a patch', async () => {
      await controller.updateProfile(
        { userId: OTHER },
        { displayName: 'Ada' },
        SELF,
        request,
      );

      expect(users.updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          targetUserId: OTHER,
          viewerUserId: SELF.id,
        }),
      );
    });

    it('on starting an email change', async () => {
      await controller.startEmailChange(
        { userId: SELF.id },
        { newEmail: 'new@example.com' },
        SELF,
        request,
      );

      expect(users.startEmailChange).toHaveBeenCalledWith(
        expect.objectContaining({ viewerUserId: SELF.id }),
      );
    });
  });

  describe('the correlation id', () => {
    it('is taken from the inbound header when there is one', async () => {
      await controller.getProfile({ userId: SELF.id }, SELF, {
        headers: { 'x-correlation-id': 'trace-abc' },
        id: 'req-1',
      } as unknown as FastifyRequest);

      expect(users.getProfile).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'trace-abc' }),
      );
    });

    it('falls back to the request id', async () => {
      await controller.getProfile({ userId: SELF.id }, SELF, request);

      expect(users.getProfile).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'req-1' }),
      );
    });
  });

  describe('deleteUser', () => {
    it('answers 204 when the erasure is already done', async () => {
      const body = await controller.deleteUser(
        { userId: OTHER },
        {},
        SELF,
        request,
        asReply(),
      );

      expect(reply.status).toHaveBeenCalledWith(204);
      expect(body).toBeUndefined();
    });

    it('answers 202 and the challenge when confirmation is needed', async () => {
      users.deleteUser.mockResolvedValue({
        status: 'confirmation_required',
        challengeId: 'challenge-1',
        method: 'otp',
        expiresAt: 'later',
      });

      const body = await controller.deleteUser(
        { userId: SELF.id },
        {},
        SELF,
        request,
        asReply(),
      );

      expect(reply.status).toHaveBeenCalledWith(202);
      expect(body).toMatchObject({ status: 'confirmation_required' });
    });

    /**
     * A courtesy to the browser, not the security boundary — what actually
     * ends the session is identity refusing to refresh a deleted account.
     */
    it('clears the cookies of somebody who erased their own account', async () => {
      await controller.deleteUser(
        { userId: SELF.id },
        {},
        SELF,
        request,
        asReply(),
      );

      expect(cookies.clear).toHaveBeenCalled();
    });

    it('leaves an administrator signed in after erasing someone else', async () => {
      await controller.deleteUser(
        { userId: OTHER },
        {},
        SELF,
        request,
        asReply(),
      );

      expect(cookies.clear).not.toHaveBeenCalled();
    });

    it('does not clear cookies while an erasure is only pending', async () => {
      users.deleteUser.mockResolvedValue({
        status: 'confirmation_required',
        challengeId: 'c',
        method: 'otp',
        expiresAt: 'later',
      });

      await controller.deleteUser(
        { userId: SELF.id },
        {},
        SELF,
        request,
        asReply(),
      );

      expect(cookies.clear).not.toHaveBeenCalled();
    });

    it('passes the stated reason through for the audit log', async () => {
      await controller.deleteUser(
        { userId: OTHER },
        { reason: 'support request' },
        SELF,
        request,
        asReply(),
      );

      expect(users.deleteUser).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'support request' }),
      );
    });
  });

  describe('confirmDeletion', () => {
    it('clears the cookies once the account is gone', async () => {
      await controller.confirmDeletion(
        { userId: SELF.id },
        { challengeId: 'c', code: '123456' },
        SELF,
        request,
        asReply(),
      );

      expect(users.confirmDeletion).toHaveBeenCalledWith(
        expect.objectContaining({
          targetUserId: SELF.id,
          viewerUserId: SELF.id,
        }),
      );
      expect(cookies.clear).toHaveBeenCalled();
    });
  });

  describe('confirmEmailChange', () => {
    /** It is `@Public()`: the link is opened in the new mailbox. */
    it('takes no viewer, because it needs no session', async () => {
      await controller.confirmEmailChange(
        { userId: SELF.id },
        { token: 'a'.repeat(43) },
        request,
      );

      expect(users.confirmEmailChange).toHaveBeenCalledWith(
        expect.objectContaining({
          targetUserId: SELF.id,
          token: 'a'.repeat(43),
        }),
      );
    });
  });
});
