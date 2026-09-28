import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Transporter } from 'nodemailer';

import { ConfigService } from '@core/config/config.service';
import { NotificationConfig } from '../../config/notification.config';
import type { RenderedMail } from '../templates/rendered-mail';
import { MailDeliveryError } from './mail-delivery.error';
import { SMTP_TRANSPORT } from './mailer.constants';

/**
 * Hands a rendered mail to the SMTP server. Knows nothing about events or
 * templates; the one thing it adds is turning whatever nodemailer threw into a
 * {@link MailDeliveryError} that says whether retrying is worth it.
 */
@Injectable()
export class MailerService implements OnModuleDestroy {
  private readonly from: string;

  constructor(
    @Inject(SMTP_TRANSPORT) private readonly transport: Transporter,
    config: ConfigService<NotificationConfig>,
  ) {
    this.from = config.get('SMTP_FROM');
  }

  async send(to: string, mail: RenderedMail): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    } catch (error) {
      throw MailDeliveryError.from(error);
    }
  }

  /** Closes the pooled connections, so shutdown does not wait on idle sockets. */
  onModuleDestroy(): void {
    this.transport.close();
  }
}
