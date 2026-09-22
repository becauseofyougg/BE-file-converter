import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma-clients/identity';
import { lastValueFrom, timeout } from 'rxjs';

import { PrismaService } from '../../database/prisma.service';
import { DOMAIN_EVENTS_CLIENT } from '../../messaging/messaging.module';
import { OutboxService } from './outbox.service';

const BATCH_SIZE = 50;
const PUBLISH_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 10;

/** The columns the claim query returns, aliased to the model's field names. */
interface ClaimedMessage {
  id: string;
  eventName: string;
  payload: Prisma.JsonValue;
  correlationId: string;
  occurredAt: Date;
  attempts: number;
}

/**
 * Drains the outbox to the broker.
 *
 * The claim is raw SQL because `FOR UPDATE SKIP LOCKED` has no Prisma query
 * API, and it is not optional: without it every identity replica would select
 * the same batch and publish it several times over. Skipping locked rows lets
 * replicas divide the backlog between them instead.
 *
 * This runs on a timer, outside any request, so it deliberately uses the base
 * client rather than `txHost.tx` — it opens its own short transaction per
 * batch and must never be swept into someone else's.
 *
 * Delivery is at-least-once by construction: the broker can accept a message
 * and the process die before the row is marked. Consumers deduplicate — for
 * mail, on `(user_id, type, ref_id)`.
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOMAIN_EVENTS_CLIENT) private readonly client: ClientProxy,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async drain(): Promise<void> {
    // A slow broker must not let ticks pile up on top of each other.
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      let published = 0;

      // Keep going while full batches come back, so a backlog clears at the
      // relay's pace rather than 50 rows per tick.
      for (;;) {
        const batch = await this.claim();

        if (batch.length === 0) {
          break;
        }

        for (const message of batch) {
          if (await this.send(message)) {
            published += 1;
          }
        }

        if (batch.length < BATCH_SIZE) {
          break;
        }
      }

      if (published > 0) {
        this.logger.log({ event: 'outbox.relay.published', published });
      }
    } finally {
      this.running = false;
    }
  }

  private claim(): Promise<ClaimedMessage[]> {
    return this.prisma.$transaction(
      (tx) =>
        tx.$queryRaw<ClaimedMessage[]>`
        SELECT
          "id",
          "event_name"     AS "eventName",
          "payload",
          "correlation_id" AS "correlationId",
          "occurred_at"    AS "occurredAt",
          "attempts"
        FROM "outbox"
        WHERE "published_at" IS NULL
          AND "attempts" < ${MAX_ATTEMPTS}
        ORDER BY "occurred_at" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `,
    );
  }

  private async send(message: ClaimedMessage): Promise<boolean> {
    try {
      await lastValueFrom(
        this.client
          .emit(
            message.eventName,
            OutboxService.envelope(
              {
                id: message.id,
                eventName: message.eventName,
                occurredAt: message.occurredAt,
                correlationId: message.correlationId,
              },
              message.payload,
            ),
          )
          .pipe(timeout(PUBLISH_TIMEOUT_MS)),
      );

      await this.prisma.outboxMessage.update({
        where: { id: message.id },
        data: { publishedAt: new Date() },
      });

      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';

      // Left unpublished: the next tick retries it. After MAX_ATTEMPTS the row
      // stops being claimed and stays for an operator to look at, rather than
      // spinning forever against a broker that will never take it.
      await this.prisma.outboxMessage.update({
        where: { id: message.id },
        data: { attempts: { increment: 1 }, lastError: reason },
      });

      this.logger.warn({
        event: 'outbox.relay.failed',
        eventName: message.eventName,
        attempts: message.attempts + 1,
        reason,
      });

      return false;
    }
  }
}
