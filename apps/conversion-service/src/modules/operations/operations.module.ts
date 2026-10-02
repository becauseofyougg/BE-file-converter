import { Module } from '@nestjs/common';

import { StorageModule } from '@storage/storage.module';
import { ConvertersModule } from '../converters/converters.module';
import { ConversionCleanupJob } from './conversion-cleanup.job';
import { ConversionLimits } from './conversion-limits';
import { ConversionOperationsController } from './conversion-operations.controller';
import { ConversionOperationsService } from './conversion-operations.service';

/**
 * Synchronous conversions over `conversion.rpc`, their history, and the
 * cleanup after them. Format-agnostic: it asks `ConverterRegistry`, and
 * never names a format.
 */
@Module({
  imports: [ConvertersModule, StorageModule],
  controllers: [ConversionOperationsController],
  providers: [
    ConversionOperationsService,
    ConversionLimits,
    ConversionCleanupJob,
  ],
})
export class OperationsModule {}
