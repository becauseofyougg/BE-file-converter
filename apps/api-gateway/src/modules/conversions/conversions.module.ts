import { Module } from '@nestjs/common';

import { StorageModule } from '@storage/storage.module';
import { ConversionsController } from './conversions.controller';
import { ConversionsService } from './conversions.service';

/**
 * `/api/convert`. StorageModule because the upload is written, and the
 * result read, here — the bytes never cross the broker.
 */
@Module({
  imports: [StorageModule],
  controllers: [ConversionsController],
  providers: [ConversionsService],
})
export class ConversionsModule {}
