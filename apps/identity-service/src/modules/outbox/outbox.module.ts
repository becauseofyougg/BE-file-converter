import { Module } from '@nestjs/common';

import { OutboxCleanupJob } from './outbox-cleanup.job';
import { OutboxRelay } from './outbox.relay';
import { OutboxService } from './outbox.service';

@Module({
  providers: [OutboxService, OutboxRelay, OutboxCleanupJob],
  exports: [OutboxService],
})
export class OutboxModule {}
