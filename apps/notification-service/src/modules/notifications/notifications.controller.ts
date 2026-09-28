import { Controller, Logger } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';

import { DOMAIN_EVENTS } from '@contracts/events/domain.events';
import {
  NOTIFICATION_RETRY_DELAYS_MS,
  QUEUES,
} from '@contracts/messaging/topology';
import {
  deadLetter,
  type RetryLadder,
  scheduleRetry,
} from '@core/messaging/rmq-retry';
import {
  NOTIFICATION_DEFINITIONS as N,
  type NotificationDefinition,
} from './notification.definitions';
import {
  type DeliveryOutcome,
  NotificationsService,
} from './notifications.service';

export const NOTIFICATION_RETRY_LADDER: RetryLadder = {
  target: QUEUES.NOTIFICATIONS,
  queue: QUEUES.notificationRetry,
  delaysMs: NOTIFICATION_RETRY_DELAYS_MS,
  deadLetterQueue: QUEUES.NOTIFICATIONS_DLQ,
};

/**
 * The events that end in someone's inbox. Each `@EventPattern` is also a
 * binding: the queue subscribes to exactly these routing keys on
 * `domain.events` and never sees the rest.
 *
 * Every message is settled explicitly — the consumer runs with `noAck: false`,
 * and a message a handler forgets to ack sits on the channel forever, taking
 * the only prefetch slot with it.
 */
@Controller()
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(private readonly notifications: NotificationsService) {}

  @EventPattern(DOMAIN_EVENTS.USER_REGISTERED)
  onUserRegistered(@Payload() message: unknown, @Ctx() context: RmqContext) {
    return this.handle(N.userRegistered, message, context);
  }

  @EventPattern(DOMAIN_EVENTS.USER_VERIFICATION_RESENT)
  onVerificationResent(
    @Payload() message: unknown,
    @Ctx() context: RmqContext,
  ) {
    return this.handle(N.verificationResent, message, context);
  }

  @EventPattern(DOMAIN_EVENTS.USER_REGISTRATION_ATTEMPTED)
  onRegistrationAttempted(
    @Payload() message: unknown,
    @Ctx() context: RmqContext,
  ) {
    return this.handle(N.registrationAttempted, message, context);
  }

  @EventPattern(DOMAIN_EVENTS.USER_LOGIN_CONFIRMATION_REQUESTED)
  onLoginConfirmationRequested(
    @Payload() message: unknown,
    @Ctx() context: RmqContext,
  ) {
    return this.handle(N.loginConfirmationRequested, message, context);
  }

  @EventPattern(DOMAIN_EVENTS.USER_EMAIL_CHANGE_REQUESTED)
  onEmailChangeRequested(
    @Payload() message: unknown,
    @Ctx() context: RmqContext,
  ) {
    return this.handle(N.emailChangeRequested, message, context);
  }

  @EventPattern(DOMAIN_EVENTS.USER_EMAIL_CHANGED)
  onEmailChanged(@Payload() message: unknown, @Ctx() context: RmqContext) {
    return this.handle(N.emailChanged, message, context);
  }

  @EventPattern(DOMAIN_EVENTS.USER_DELETION_REQUESTED)
  onDeletionRequested(@Payload() message: unknown, @Ctx() context: RmqContext) {
    return this.handle(N.deletionRequested, message, context);
  }

  @EventPattern(DOMAIN_EVENTS.USER_DELETED)
  onUserDeleted(@Payload() message: unknown, @Ctx() context: RmqContext) {
    return this.handle(N.userDeleted, message, context);
  }

  private async handle<P extends { userId: string }>(
    definition: NotificationDefinition<P>,
    message: unknown,
    context: RmqContext,
  ): Promise<void> {
    let outcome: DeliveryOutcome;

    try {
      outcome = await this.notifications.deliver(definition, message);
    } catch (error) {
      // Not a mail failure — those come back as an outcome. This is the
      // database or a bug, and the message is not at fault: it goes on the
      // ladder, whose length bounds how long a real bug can keep it coming back.
      this.logger.error({
        event: 'notification.handler_failed',
        eventName: definition.event,
        reason: error instanceof Error ? error.message : 'unknown',
      });

      outcome = { kind: 'retry' };
    }

    await this.settle(definition, outcome, context);
  }

  private async settle<P extends { userId: string }>(
    definition: NotificationDefinition<P>,
    outcome: DeliveryOutcome,
    context: RmqContext,
  ): Promise<void> {
    try {
      if (outcome.kind === 'retry') {
        const result = await scheduleRetry(context, NOTIFICATION_RETRY_LADDER);

        if (result === 'exhausted') {
          this.logger.error({
            event: 'notification.dead_lettered',
            eventName: definition.event,
          });
        }

        return;
      }

      if (outcome.kind === 'rejected') {
        // Kept, not dropped: a malformed event is a bug in the publisher, and
        // the message is the evidence.
        await deadLetter(context, NOTIFICATION_RETRY_LADDER);

        return;
      }

      const channel = context.getChannelRef() as {
        ack: (message: unknown) => void;
      };
      channel.ack(context.getMessage());
    } catch (error) {
      // The broker refused the retry copy or the ack. Nothing is lost: the
      // message stays unacked and comes back when the channel is reopened.
      this.logger.error({
        event: 'notification.settle_failed',
        eventName: definition.event,
        outcome: outcome.kind,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}
