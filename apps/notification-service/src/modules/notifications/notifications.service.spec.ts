import { NotificationStatus } from '@prisma-clients/notification';

import { DOMAIN_EVENTS } from '@contracts/events/domain.events';
import { ConfigService } from '@core/config/config.service';
import type { NotificationConfig } from '../../config/notification.config';
import { MailDeliveryError } from '../mailer/mail-delivery.error';
import type { MailerService } from '../mailer/mailer.service';
import { LinkService } from '../templates/link.service';
import { TemplatesService } from '../templates/templates.service';
import type {
  Notification,
  NotificationLogService,
} from './notification-log.service';
import { NOTIFICATION_DEFINITIONS as N } from './notification.definitions';
import { MAX_ATTEMPTS, NotificationsService } from './notifications.service';

const EVENT_ID = '0b8a4d5e-7c1f-4e2a-9b3d-6f5e4d3c2b1a';
const USER_ID = '6f1c2f34-0a4b-4c38-9d3a-1c5b2e7f8a90';
const SECRET = '482915';
const EMAIL = 'jane@example.com';

const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000).toISOString();

function envelope(payload: Record<string, unknown>, overrides = {}) {
  return {
    eventId: EVENT_ID,
    eventName: DOMAIN_EVENTS.USER_REGISTERED,
    occurredAt: new Date().toISOString(),
    correlationId: 'correlation-1',
    payload,
    ...overrides,
  };
}

const registered = (confirmation: Record<string, unknown> | null = {}) =>
  envelope({
    userId: USER_ID,
    email: EMAIL,
    ...(confirmation && {
      confirmation: {
        method: 'otp',
        secret: SECRET,
        expiresAt: inMinutes(10),
        ...confirmation,
      },
    }),
  });

function row(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'row-1',
    refId: EVENT_ID,
    userId: USER_ID,
    type: DOMAIN_EVENTS.USER_REGISTERED,
    channel: 'EMAIL',
    status: NotificationStatus.PENDING,
    attempts: 0,
    lastError: null,
    correlationId: 'correlation-1',
    sentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Notification;
}

describe('NotificationsService', () => {
  let log: jest.Mocked<NotificationLogService>;
  let mailer: jest.Mocked<MailerService>;
  let service: NotificationsService;
  let logged: Array<[string, unknown]>;

  beforeEach(() => {
    log = {
      open: jest.fn().mockResolvedValue(row()),
      markSent: jest.fn().mockResolvedValue(row()),
      markRetrying: jest.fn().mockResolvedValue(row()),
      markFailed: jest.fn().mockResolvedValue(row()),
      markExpired: jest.fn().mockResolvedValue(row()),
    } as unknown as jest.Mocked<NotificationLogService>;

    mailer = {
      send: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<MailerService>;

    // The real templates: what reaches the mailer is part of what is tested.
    const templates = new TemplatesService(
      new LinkService(
        new ConfigService<NotificationConfig>({
          APP_PUBLIC_URL: 'https://app.example.com',
        }),
      ),
    );

    service = new NotificationsService(log, templates, mailer);

    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(service['logger'], level)
        .mockImplementation((line: unknown) => {
          logged.push([level, line]);
        });
    }
  });

  describe('the happy path', () => {
    it('records the event, sends the mail, and marks it sent', async () => {
      await expect(
        service.deliver(N.userRegistered, registered()),
      ).resolves.toEqual({ kind: 'sent' });

      expect(log.open).toHaveBeenCalledWith({
        refId: EVENT_ID,
        userId: USER_ID,
        type: DOMAIN_EVENTS.USER_REGISTERED,
        channel: 'EMAIL',
        correlationId: 'correlation-1',
      });
      expect(mailer.send).toHaveBeenCalledWith(
        EMAIL,
        expect.objectContaining({
          subject: 'Confirm your email address',
          text: expect.stringContaining(SECRET),
        }),
      );
      expect(log.markSent).toHaveBeenCalledWith('row-1', 1);
    });

    it('counts on from the attempts a previous delivery already made', async () => {
      log.open.mockResolvedValue(
        row({ status: NotificationStatus.RETRYING, attempts: 2 }),
      );

      await service.deliver(N.userRegistered, registered());

      expect(log.markSent).toHaveBeenCalledWith('row-1', 3);
    });

    /**
     * The recipient and the code go into the mail and nowhere else — not the
     * send log, not a log line.
     */
    it('never logs the address or the code', async () => {
      await service.deliver(N.userRegistered, registered());

      const everything = JSON.stringify(logged);

      expect(everything).not.toContain(EMAIL);
      expect(everything).not.toContain(SECRET);
      expect(logged).toContainEqual([
        'log',
        expect.objectContaining({
          event: 'notification.sent',
          userId: USER_ID,
          eventId: EVENT_ID,
          correlationId: 'correlation-1',
        }),
      ]);
    });
  });

  describe('idempotency', () => {
    it.each([
      NotificationStatus.SENT,
      NotificationStatus.FAILED,
      NotificationStatus.EXPIRED,
    ])(
      'sends nothing when an earlier delivery already ended %s',
      async (status) => {
        log.open.mockResolvedValue(row({ status }));

        await expect(
          service.deliver(N.userRegistered, registered()),
        ).resolves.toEqual({ kind: 'duplicate' });

        expect(mailer.send).not.toHaveBeenCalled();
      },
    );

    /** The previous attempt failed transiently; this is the retry. */
    it('tries again when the earlier delivery is still retrying', async () => {
      log.open.mockResolvedValue(row({ status: NotificationStatus.RETRYING }));

      await expect(
        service.deliver(N.userRegistered, registered()),
      ).resolves.toEqual({ kind: 'sent' });
    });
  });

  it('records nothing for an event that needs no mail', async () => {
    await expect(
      service.deliver(N.userRegistered, registered(null)),
    ).resolves.toEqual({ kind: 'skipped' });

    expect(log.open).not.toHaveBeenCalled();
    expect(mailer.send).not.toHaveBeenCalled();
  });

  /**
   * A late code is worse than none: the user types it, it fails, and they
   * conclude the product is broken.
   */
  it('drops a code that expired before it could be sent', async () => {
    await expect(
      service.deliver(
        N.userRegistered,
        registered({ expiresAt: inMinutes(-1) }),
      ),
    ).resolves.toEqual({ kind: 'expired' });

    expect(log.markExpired).toHaveBeenCalledWith('row-1');
    expect(mailer.send).not.toHaveBeenCalled();
  });

  it('sends a notice that has no expiry however late it is', async () => {
    await expect(
      service.deliver(
        N.emailChanged,
        envelope({
          userId: USER_ID,
          previousEmail: 'old@example.com',
          newEmail: 'new@example.com',
        }),
      ),
    ).resolves.toEqual({ kind: 'sent' });

    expect(mailer.send).toHaveBeenCalledWith(
      'old@example.com',
      expect.anything(),
    );
  });

  describe('when the send fails', () => {
    it('schedules a retry for a transient failure, and records why', async () => {
      mailer.send.mockRejectedValue(new MailDeliveryError(true, '421 busy'));

      await expect(
        service.deliver(N.userRegistered, registered()),
      ).resolves.toEqual({ kind: 'retry' });

      expect(log.markRetrying).toHaveBeenCalledWith('row-1', 1, '421 busy');
      expect(log.markSent).not.toHaveBeenCalled();
    });

    it('gives up at once on a permanent failure', async () => {
      mailer.send.mockRejectedValue(
        new MailDeliveryError(false, '550 no such user'),
      );

      await expect(
        service.deliver(N.userRegistered, registered()),
      ).resolves.toEqual({ kind: 'failed' });

      expect(log.markFailed).toHaveBeenCalledWith(
        'row-1',
        1,
        '550 no such user',
      );
    });

    it('gives up on a transient failure once the attempts run out', async () => {
      log.open.mockResolvedValue(
        row({
          status: NotificationStatus.RETRYING,
          attempts: MAX_ATTEMPTS - 1,
        }),
      );
      mailer.send.mockRejectedValue(new MailDeliveryError(true, '421 busy'));

      await expect(
        service.deliver(N.userRegistered, registered()),
      ).resolves.toEqual({ kind: 'failed' });

      expect(log.markFailed).toHaveBeenCalledWith(
        'row-1',
        MAX_ATTEMPTS,
        '421 busy',
      );
    });

    it('classifies an error the mailer did not', async () => {
      mailer.send.mockRejectedValue(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      );

      await expect(
        service.deliver(N.userRegistered, registered()),
      ).resolves.toEqual({ kind: 'retry' });
    });

    it('allows the first attempt plus one per rung of the ladder', () => {
      expect(MAX_ATTEMPTS).toBe(5);
    });
  });

  describe('a malformed event', () => {
    it.each([
      ['no envelope at all', undefined],
      ['an envelope without an event id', { ...registered(), eventId: 'nope' }],
      ['a payload that is not an object', { ...registered(), payload: 'x' }],
      ['a payload without an address', envelope({ userId: USER_ID })],
      [
        'a confirmation with an unknown method',
        registered({ method: 'carrier-pigeon' }),
      ],
    ])('is rejected: %s', async (_label, message) => {
      await expect(service.deliver(N.userRegistered, message)).resolves.toEqual(
        { kind: 'rejected' },
      );

      expect(log.open).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
    });

    /** Values may be a code; the field names are enough to find the bug. */
    it('names the fields that failed, never their values', async () => {
      await service.deliver(
        N.userRegistered,
        registered({ method: 'carrier-pigeon' }),
      );

      expect(logged).toContainEqual([
        'error',
        expect.objectContaining({
          event: 'notification.rejected',
          eventId: EVENT_ID,
          fields: ['confirmation.method'],
        }),
      ]);
      expect(JSON.stringify(logged)).not.toContain(SECRET);
    });

    it('does not trust an event id it could not validate', async () => {
      await service.deliver(N.userRegistered, { eventId: 42 });

      expect(logged).toContainEqual([
        'error',
        expect.objectContaining({ eventId: null, correlationId: null }),
      ]);
    });

    /**
     * A publisher adding a field is a compatible change; a consumer that has
     * not been redeployed yet must keep working.
     */
    it('accepts, and ignores, a field it does not know', async () => {
      const message = registered();
      message.payload.addedLater = true;

      await expect(service.deliver(N.userRegistered, message)).resolves.toEqual(
        { kind: 'sent' },
      );
    });
  });

  it('lets a database failure through, for the controller to retry', async () => {
    log.open.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.deliver(N.userRegistered, registered()),
    ).rejects.toThrow('connection lost');
  });
});
