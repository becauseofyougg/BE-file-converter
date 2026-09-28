import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import {
  type Notification,
  type NotificationChannel,
  NotificationStatus,
  Prisma,
} from '@prisma-clients/notification';

import { PrismaService } from '../../database/prisma.service';

export type { Notification };

/** Settled one way or another; a redelivery of any of these sends nothing. */
export const TERMINAL_STATUSES: ReadonlySet<NotificationStatus> = new Set([
  NotificationStatus.SENT,
  NotificationStatus.FAILED,
  NotificationStatus.EXPIRED,
]);

export interface NotificationRef {
  refId: string;
  userId: string;
  type: string;
  channel: NotificationChannel;
  correlationId: string;
}

/**
 * The send log. Its unique `(ref_id, channel)` is what makes delivery
 * idempotent: the outbox relay is at-least-once, so the same event can arrive
 * twice, and the second arrival finds the first one's row.
 */
@Injectable()
export class NotificationLogService {
  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
  ) {}

  /**
   * The row for this event, created if it is the first time it has been seen.
   *
   * Insert-then-read rather than read-then-insert: two replicas handed the same
   * redelivered event would both pass a `SELECT`, and the unique index is the
   * only thing that settles which of them got there first.
   *
   * Not for use inside `@Transactional()`: Postgres aborts a transaction on the
   * failed insert, and the read that follows would be refused with it.
   */
  async open(ref: NotificationRef): Promise<Notification> {
    try {
      return await this.txHost.tx.notification.create({ data: ref });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.txHost.tx.notification.findUniqueOrThrow({
          where: {
            refId_channel: { refId: ref.refId, channel: ref.channel },
          },
        });
      }

      throw error;
    }
  }

  markSent(id: string, attempts: number): Promise<Notification> {
    return this.settle(id, {
      status: NotificationStatus.SENT,
      attempts,
      sentAt: new Date(),
      lastError: null,
    });
  }

  markRetrying(
    id: string,
    attempts: number,
    lastError: string,
  ): Promise<Notification> {
    return this.settle(id, {
      status: NotificationStatus.RETRYING,
      attempts,
      lastError,
    });
  }

  markFailed(
    id: string,
    attempts: number,
    lastError: string,
  ): Promise<Notification> {
    return this.settle(id, {
      status: NotificationStatus.FAILED,
      attempts,
      lastError,
    });
  }

  markExpired(id: string): Promise<Notification> {
    return this.settle(id, { status: NotificationStatus.EXPIRED });
  }

  private settle(
    id: string,
    data: Prisma.NotificationUpdateInput,
  ): Promise<Notification> {
    return this.txHost.tx.notification.update({ where: { id }, data });
  }
}
