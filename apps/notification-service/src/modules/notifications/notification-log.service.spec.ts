import type { TransactionHost } from '@nestjs-cls/transactional';
import {
  NotificationChannel,
  NotificationStatus,
  Prisma,
} from '@prisma-clients/notification';

import {
  NotificationLogService,
  TERMINAL_STATUSES,
} from './notification-log.service';

const REF = {
  refId: '0b8a4d5e-7c1f-4e2a-9b3d-6f5e4d3c2b1a',
  userId: '6f1c2f34-0a4b-4c38-9d3a-1c5b2e7f8a90',
  type: 'user.registered',
  channel: NotificationChannel.EMAIL,
  correlationId: 'correlation-1',
};

const ROW = { id: 'row-1', ...REF, status: NotificationStatus.PENDING };

describe('NotificationLogService', () => {
  let notification: {
    create: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
  };
  let service: NotificationLogService;

  beforeEach(() => {
    notification = {
      create: jest.fn().mockResolvedValue(ROW),
      findUniqueOrThrow: jest.fn().mockResolvedValue(ROW),
      update: jest.fn().mockResolvedValue(ROW),
    };

    service = new NotificationLogService({
      tx: { notification },
    } as unknown as TransactionHost<never>);
  });

  describe('open', () => {
    it('records a first sighting', async () => {
      await expect(service.open(REF)).resolves.toBe(ROW);

      expect(notification.create).toHaveBeenCalledWith({ data: REF });
    });

    /**
     * The unique index, not a prior SELECT, decides who got there first — two
     * replicas handed the same redelivery would both pass a SELECT.
     */
    it('returns the existing row when the event was seen before', async () => {
      const existing = { ...ROW, status: NotificationStatus.SENT };
      notification.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      notification.findUniqueOrThrow.mockResolvedValue(existing);

      await expect(service.open(REF)).resolves.toBe(existing);

      expect(notification.findUniqueOrThrow).toHaveBeenCalledWith({
        where: {
          refId_channel: {
            refId: REF.refId,
            channel: NotificationChannel.EMAIL,
          },
        },
      });
    });

    it('lets any other failure through', async () => {
      notification.create.mockRejectedValue(new Error('connection lost'));

      await expect(service.open(REF)).rejects.toThrow('connection lost');
      expect(notification.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('settling', () => {
    it('clears the last error once a send succeeds', async () => {
      await service.markSent('row-1', 2);

      expect(notification.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: {
          status: NotificationStatus.SENT,
          attempts: 2,
          sentAt: expect.any(Date),
          lastError: null,
        },
      });
    });

    it.each([
      ['markRetrying', NotificationStatus.RETRYING],
      ['markFailed', NotificationStatus.FAILED],
    ] as const)('%s records the attempt and why', async (method, status) => {
      await service[method]('row-1', 3, '421 busy');

      expect(notification.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { status, attempts: 3, lastError: '421 busy' },
      });
    });

    it('marks an expired one without counting an attempt', async () => {
      await service.markExpired('row-1');

      expect(notification.update).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { status: NotificationStatus.EXPIRED },
      });
    });
  });

  it('treats sent, failed and expired as settled — and nothing else', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(
      [
        NotificationStatus.EXPIRED,
        NotificationStatus.FAILED,
        NotificationStatus.SENT,
      ].sort(),
    );
  });
});
