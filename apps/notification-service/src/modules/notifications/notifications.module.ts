import { Module } from '@nestjs/common';

import { MailerModule } from '../mailer/mailer.module';
import { TemplatesModule } from '../templates/templates.module';
import { NotificationLogService } from './notification-log.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [MailerModule, TemplatesModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationLogService],
})
export class NotificationsModule {}
