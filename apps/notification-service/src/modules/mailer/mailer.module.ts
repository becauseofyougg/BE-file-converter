import { Module } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import { ConfigService } from '@core/config/config.service';
import { NotificationConfig } from '../../config/notification.config';
import { SMTP_TRANSPORT } from './mailer.constants';
import { MailerService } from './mailer.service';

/**
 * nodemailer's own defaults wait two minutes for a connection and ten for an
 * idle socket. A send that has not finished in these is better handed back to
 * the retry ladder than left holding the consumer.
 */
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 30_000;

@Module({
  providers: [
    {
      provide: SMTP_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<NotificationConfig>) => {
        const user = config.get('SMTP_USER');

        return createTransport({
          // A pool keeps the connection open between messages, which is most
          // of the cost of a send once there is any volume.
          pool: true,
          host: config.get('SMTP_HOST'),
          port: config.getNumber('SMTP_PORT'),
          secure: config.getBoolean('SMTP_SECURE'),
          // Mailhog takes anonymous SMTP; a real provider does not.
          auth: user ? { user, pass: config.get('SMTP_PASSWORD') } : undefined,
          connectionTimeout: CONNECTION_TIMEOUT_MS,
          greetingTimeout: GREETING_TIMEOUT_MS,
          socketTimeout: SOCKET_TIMEOUT_MS,
        });
      },
    },
    MailerService,
  ],
  exports: [MailerService],
})
export class MailerModule {}
