import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import type { OutboxMessage, Prisma } from '@prisma-clients/identity';

import type {
  DomainEventName,
  DomainEventEnvelope,
} from '@contracts/events/domain.events';
import { PrismaService } from '../../database/prisma.service';

export type { OutboxMessage };

/**
 * Writes events into the outbox. Called from inside a domain transaction —
 * `txHost.tx` resolves to the ambient transaction, so the event and the state
 * change commit or roll back together.
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly txHost: TransactionHost<
      TransactionalAdapterPrisma<PrismaService>
    >,
  ) {}

  async publish<T extends object>(
    eventName: DomainEventName,
    payload: T,
    correlationId: string,
  ): Promise<void> {
    await this.txHost.tx.outboxMessage.create({
      data: {
        eventName,
        payload: payload as unknown as Prisma.InputJsonValue,
        correlationId,
        occurredAt: new Date(),
        publishedAt: null,
        attempts: 0,
      },
    });
  }

  /**
   * The shape a consumer receives. Built here so the envelope is identical
   * whether it came from the relay or from a test.
   */
  static envelope<T>(
    message: Pick<
      OutboxMessage,
      'id' | 'eventName' | 'occurredAt' | 'correlationId'
    >,
    payload: T,
  ): DomainEventEnvelope<T> {
    return {
      eventId: message.id,
      eventName: message.eventName as DomainEventName,
      occurredAt: message.occurredAt.toISOString(),
      correlationId: message.correlationId,
      payload,
    };
  }
}
