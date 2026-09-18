import { join } from 'node:path';

import { Module } from '@nestjs/common';

import { ConfigModule } from '@core/config/config.module';
import { DatabaseModule } from '@core/database/database.module';
import { HealthModule } from '@core/health/health.module';
import { ObservabilityModule } from '@obs/logger.module';
import { StorageModule } from '@storage/storage.module';

import { conversionConfigSchema } from './config/conversion.config';

/**
 *
 * Application modules
 *
 */
import { ConvertersModule } from './modules/converters/converters.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { WorkerModule } from './modules/worker/worker.module';

@Module({
  imports: [
    ConfigModule.forRoot({ validationSchema: conversionConfigSchema }),
    ObservabilityModule,
    // Owns the `conversion` schema: jobs, job_events, outbox.
    DatabaseModule.forRoot({
      migrations: [join(__dirname, 'database/migrations/*.migration{.ts,.js}')],
    }),
    HealthModule,
    StorageModule,
    /**
     *
     * Application modules
     *
     */
    ConvertersModule,
    PipelineModule,
    WorkerModule,
  ],
})
export class AppModule {}
