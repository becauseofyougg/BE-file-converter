import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma-clients/notification';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import type { DomainEventName } from '@contracts/events/domain.events';
import { NOTIFICATION_RETRY_DELAYS_MS } from '@contracts/messaging/topology';
import { MailDeliveryError } from '../mailer/mail-delivery.error';
import { MailerService } from '../mailer/mailer.service';
import { TemplatesService } from '../templates/templates.service';
import { EventEnvelopeDto } from './dto/event.dto';
import type { NotificationDefinition } from './notification.definitions';
import {
  NotificationLogService,
  TERMINAL_STATUSES,
} from './notification-log.service';

/**
 * The first attempt plus one per rung of the retry ladder. Counted in the send
 * log rather than in the message, so a redelivery after a crash does not start
 * the count again.
 */
export const MAX_ATTEMPTS = NOTIFICATION_RETRY_DELAYS_MS.length + 1;

/**
 * What became of one delivery, for the controller to settle the message by.
 * Only `retry` leaves the message in play; everything else is final.
 */
export type DeliveryOutcome =
  | { kind: 'sent' }
  /** Already settled by an earlier delivery of the same event. */
  | { kind: 'duplicate' }
  /** This event needs no mail — e.g. registration with confirmation off. */
  | { kind: 'skipped' }
  | { kind: 'expired' }
  /** The mail can never be delivered, or the attempts ran out. */
  | { kind: 'failed' }
  /** The message itself is malformed; no amount of retrying fixes it. */
  | { kind: 'rejected' }
  | { kind: 'retry' };

/**
 * validate → render → record → send, for one event.
 *
 * What it never does is write the recipient or the code anywhere but the mail:
 * not the send log, not a log line. Both arrive in the event, go straight into
 * the rendered message, and are gone when the handler returns.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly log: NotificationLogService,
    private readonly templates: TemplatesService,
    private readonly mailer: MailerService,
  ) {}

  async deliver<P extends { userId: string }>(
    definition: NotificationDefinition<P>,
    message: unknown,
  ): Promise<DeliveryOutcome> {
    const parsed = await this.parse(definition, message);

    if (!parsed) {
      return { kind: 'rejected' };
    }

    const { envelope, payload } = parsed;
    const context = {
      eventName: definition.event,
      eventId: envelope.eventId,
      userId: payload.userId,
      correlationId: envelope.correlationId,
    };

    const mail = definition.render(payload, this.templates);

    if (!mail) {
      this.logger.debug({ event: 'notification.skipped', ...context });

      return { kind: 'skipped' };
    }

    const record = await this.log.open({
      refId: envelope.eventId,
      userId: payload.userId,
      type: definition.event,
      channel: NotificationChannel.EMAIL,
      correlationId: envelope.correlationId,
    });

    if (TERMINAL_STATUSES.has(record.status)) {
      this.logger.log({
        event: 'notification.duplicate',
        ...context,
        status: record.status,
      });

      return { kind: 'duplicate' };
    }

    const expiresAt = definition.expiresAt?.(payload);

    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      await this.log.markExpired(record.id);

      // A warning, because it means mail is running further behind than a
      // code lives — that is a backlog someone should be looking at.
      this.logger.warn({
        event: 'notification.expired',
        ...context,
        attempts: record.attempts,
      });

      return { kind: 'expired' };
    }

    const attempts = record.attempts + 1;

    try {
      await this.mailer.send(definition.recipient(payload), mail);
    } catch (error) {
      const failure = MailDeliveryError.from(error);

      if (failure.retryable && attempts < MAX_ATTEMPTS) {
        await this.log.markRetrying(record.id, attempts, failure.summary);

        this.logger.warn({
          event: 'notification.retrying',
          ...context,
          attempts,
          reason: failure.summary,
        });

        return { kind: 'retry' };
      }

      await this.log.markFailed(record.id, attempts, failure.summary);

      this.logger.error({
        event: 'notification.failed',
        ...context,
        attempts,
        retryable: failure.retryable,
        reason: failure.summary,
      });

      return { kind: 'failed' };
    }

    await this.log.markSent(record.id, attempts);

    this.logger.log({ event: 'notification.sent', ...context, attempts });

    return { kind: 'sent' };
  }

  private async parse<P extends { userId: string }>(
    definition: NotificationDefinition<P>,
    message: unknown,
  ): Promise<{ envelope: EventEnvelopeDto; payload: P } | null> {
    const envelope = plainToInstance(EventEnvelopeDto, message ?? {});
    const envelopeErrors = await validate(envelope);

    if (envelopeErrors.length > 0) {
      this.reject(definition.event, envelopeErrors, envelope);

      return null;
    }

    const payload = plainToInstance(definition.payload, envelope.payload);

    // `whitelist` without `forbidNonWhitelisted`: a publisher adding a field is
    // a compatible change and must not start failing a consumer that has not
    // been redeployed yet. Unknown fields are dropped, not refused.
    const payloadErrors = await validate(payload, { whitelist: true });

    if (payloadErrors.length > 0) {
      this.reject(definition.event, payloadErrors, envelope);

      return null;
    }

    return { envelope, payload };
  }

  /** Names the fields that failed — never their values, which may be a code. */
  private reject(
    eventName: DomainEventName,
    errors: ValidationError[],
    envelope: Partial<EventEnvelopeDto>,
  ): void {
    this.logger.error({
      event: 'notification.rejected',
      eventName,
      eventId: typeof envelope.eventId === 'string' ? envelope.eventId : null,
      correlationId:
        typeof envelope.correlationId === 'string'
          ? envelope.correlationId
          : null,
      fields: flattenFields(errors),
    });
  }
}

function flattenFields(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = `${prefix}${error.property}`;

    return error.children?.length
      ? flattenFields(error.children, `${path}.`)
      : [path];
  });
}
