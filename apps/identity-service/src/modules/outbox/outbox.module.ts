import { Module } from '@nestjs/common';

import { OutboxRelay } from './outbox.relay';
import { OutboxService } from './outbox.service';

@Module({
  providers: [OutboxService, OutboxRelay],
  exports: [OutboxService],
})
export class OutboxModule {}
