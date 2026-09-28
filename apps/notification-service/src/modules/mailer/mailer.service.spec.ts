import type { Transporter } from 'nodemailer';

import { ConfigService } from '@core/config/config.service';
import type { NotificationConfig } from '../../config/notification.config';
import { MailDeliveryError } from './mail-delivery.error';
import { MailerService } from './mailer.service';

describe('MailerService', () => {
  let transport: { sendMail: jest.Mock; close: jest.Mock };
  let service: MailerService;

  const mail = { subject: 'Hello', text: 'plain', html: '<p>rich</p>' };

  beforeEach(() => {
    transport = {
      sendMail: jest.fn().mockResolvedValue({ messageId: 'id' }),
      close: jest.fn(),
    };

    service = new MailerService(
      transport as unknown as Transporter,
      new ConfigService<NotificationConfig>({
        SMTP_FROM: 'no-reply@example.com',
      }),
    );
  });

  it('sends both bodies from the configured address', async () => {
    await service.send('jane@example.com', mail);

    expect(transport.sendMail).toHaveBeenCalledWith({
      from: 'no-reply@example.com',
      to: 'jane@example.com',
      subject: 'Hello',
      text: 'plain',
      html: '<p>rich</p>',
    });
  });

  it('turns a transport failure into one that says whether to retry', async () => {
    transport.sendMail.mockRejectedValue(
      Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }),
    );

    const error = (await service
      .send('jane@example.com', mail)
      .catch((caught: unknown) => caught)) as MailDeliveryError;

    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error.retryable).toBe(false);
  });

  it('closes the pool on shutdown', () => {
    service.onModuleDestroy();

    expect(transport.close).toHaveBeenCalled();
  });
});
