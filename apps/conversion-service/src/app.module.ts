import { Module } from '@nestjs/common';

import { ConfigModule } from '@core/config/config.module';
import { storageProbe } from '@core/health/broker.probe';
import { HealthModule } from '@core/health/health.module';
import { HEALTH_PROBES, databaseProbe } from '@core/health/health.probes';
import { ObservabilityModule } from '@obs/logger.module';
import { StorageModule } from '@storage/storage.module';
import { StorageService } from '@storage/storage.service';

import { conversionConfigSchema } from './config/conversion.config';
import { PrismaModule } from './database/prisma.module';
import { PrismaService } from './database/prisma.service';

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
    PrismaModule,
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
  providers: [
    {
      // A converter is useless without both: the database it records jobs in,
      // and the bucket it reads inputs from and writes results to.
      provide: HEALTH_PROBES,
      inject: [PrismaService, StorageService],
      useFactory: (prisma: PrismaService, storage: StorageService) => [
        databaseProbe(prisma),
        storageProbe(storage),
      ],
    },
  ],
})
export class AppModule {}
