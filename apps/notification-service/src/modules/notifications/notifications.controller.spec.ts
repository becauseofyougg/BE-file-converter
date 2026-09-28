jest.mock('@core/messaging/rmq-retry', () => ({
  scheduleRetry: jest.fn(),
  deadLetter: jest.fn(),
}));

// The DTOs are decorated, and nothing else here would load the polyfill.
import 'reflect-metadata';

import type { RmqContext } from '@nestjs/microservices';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';

import { DOMAIN_EVENTS } from '@contracts/events/domain.events';
import { QUEUES } from '@contracts/messaging/topology';
import { deadLetter, scheduleRetry } from '@core/messaging/rmq-retry';
import { NOTIFICATION_DEFINITIONS as N } from './notification.definitions';
import {
  NOTIFICATION_RETRY_LADDER,
  NotificationsController,
} from './notifications.controller';
import type {
  DeliveryOutcome,
  NotificationsService,
} from './notifications.service';

const scheduleRetryMock = scheduleRetry as jest.Mock;
const deadLetterMock = deadLetter as jest.Mock;

describe('NotificationsController', () => {
  let notifications: jest.Mocked<NotificationsService>;
  let controller: NotificationsController;
  let ack: jest.Mock;
  let context: RmqContext;
  const message = { fields: { deliveryTag: 1 } };
  const event = { eventId: 'e' };

  beforeEach(() => {
    scheduleRetryMock.mockReset().mockResolvedValue('scheduled');
    deadLetterMock.mockReset().mockResolvedValue(undefined);

    notifications = {
      deliver: jest.fn().mockResolvedValue({ kind: 'sent' }),
    } as unknown as jest.Mocked<NotificationsService>;

    controller = new NotificationsController(notifications);
    jest
      .spyOn(controller['logger'], 'error')
      .mockImplementation(() => undefined);

    ack = jest.fn();
    context = {
      getChannelRef: () => ({ ack }),
      getMessage: () => message,
    } as unknown as RmqContext;
  });

  /**
   * Each pattern is also a queue binding, so a handler on the wrong name is
   * mail that silently never arrives.
   */
  it.each([
    ['onUserRegistered', DOMAIN_EVENTS.USER_REGISTERED, N.userRegistered],
    [
      'onVerificationResent',
      DOMAIN_EVENTS.USER_VERIFICATION_RESENT,
      N.verificationResent,
    ],
    [
      'onRegistrationAttempted',
      DOMAIN_EVENTS.USER_REGISTRATION_ATTEMPTED,
      N.registrationAttempted,
    ],
    [
      'onLoginConfirmationRequested',
      DOMAIN_EVENTS.USER_LOGIN_CONFIRMATION_REQUESTED,
      N.loginConfirmationRequested,
    ],
    [
      'onEmailChangeRequested',
      DOMAIN_EVENTS.USER_EMAIL_CHANGE_REQUESTED,
      N.emailChangeRequested,
    ],
    ['onEmailChanged', DOMAIN_EVENTS.USER_EMAIL_CHANGED, N.emailChanged],
    [
      'onDeletionRequested',
      DOMAIN_EVENTS.USER_DELETION_REQUESTED,
      N.deletionRequested,
    ],
    ['onUserDeleted', DOMAIN_EVENTS.USER_DELETED, N.userDeleted],
  ] as const)(
    '%s listens on %s and delivers it',
    async (method, pattern, definition) => {
      const handler = controller[method] as (
        m: unknown,
        c: RmqContext,
      ) => Promise<void>;

      expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([pattern]);

      await handler.call(controller, event, context);

      expect(notifications.deliver).toHaveBeenCalledWith(definition, event);
    },
  );

  it.each<DeliveryOutcome['kind']>([
    'sent',
    'duplicate',
    'skipped',
    'expired',
    'failed',
  ])('acks a delivery that ended %s', async (kind) => {
    notifications.deliver.mockResolvedValue({ kind } as DeliveryOutcome);

    await controller.onUserRegistered(event, context);

    expect(ack).toHaveBeenCalledWith(message);
    expect(scheduleRetryMock).not.toHaveBeenCalled();
  });

  it('puts a retry on the ladder instead of acking it here', async () => {
    notifications.deliver.mockResolvedValue({ kind: 'retry' });

    await controller.onUserRegistered(event, context);

    expect(scheduleRetryMock).toHaveBeenCalledWith(
      context,
      NOTIFICATION_RETRY_LADDER,
    );
    expect(ack).not.toHaveBeenCalled();
  });

  it('says so when the ladder is spent', async () => {
    notifications.deliver.mockResolvedValue({ kind: 'retry' });
    scheduleRetryMock.mockResolvedValue('exhausted');

    await controller.onUserRegistered(event, context);

    expect(controller['logger'].error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notification.dead_lettered' }),
    );
  });

  /** Kept as evidence of a publisher bug, not dropped. */
  it('dead-letters a malformed event', async () => {
    notifications.deliver.mockResolvedValue({ kind: 'rejected' });

    await controller.onUserRegistered(event, context);

    expect(deadLetterMock).toHaveBeenCalledWith(
      context,
      NOTIFICATION_RETRY_LADDER,
    );
    expect(ack).not.toHaveBeenCalled();
  });

  /** The database, or a bug — not the message's fault, so it goes round again. */
  it('retries when delivery itself throws', async () => {
    notifications.deliver.mockRejectedValue(new Error('connection lost'));

    await controller.onUserRegistered(event, context);

    expect(scheduleRetryMock).toHaveBeenCalled();
    expect(controller['logger'].error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification.handler_failed',
        reason: 'connection lost',
      }),
    );
  });

  it('survives a broker that refuses to settle, leaving the message for redelivery', async () => {
    notifications.deliver.mockResolvedValue({ kind: 'retry' });
    scheduleRetryMock.mockRejectedValue(new Error('channel closed'));

    await expect(
      controller.onUserRegistered(event, context),
    ).resolves.toBeUndefined();

    expect(controller['logger'].error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification.settle_failed',
        reason: 'channel closed',
      }),
    );
  });

  it('retries into the notification queue, and parks what is left in its DLQ', () => {
    expect(NOTIFICATION_RETRY_LADDER.target).toBe(QUEUES.NOTIFICATIONS);
    expect(NOTIFICATION_RETRY_LADDER.queue(1)).toBe(
      QUEUES.notificationRetry(1),
    );
    expect(NOTIFICATION_RETRY_LADDER.deadLetterQueue).toBe(
      QUEUES.NOTIFICATIONS_DLQ,
    );
  });
});
