import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { ConfigModule } from '@core/config/config.module';
import { storageProbe } from '@core/health/broker.probe';
import { HealthModule } from '@core/health/health.module';
import { databaseProbe } from '@core/health/health.probes';
import { ObservabilityModule } from '@obs/logger.module';
import { StorageModule } from '@storage/storage.module';
import { FileStorage } from '@storage/file-storage';

import { conversionConfigSchema } from './config/conversion.config';
import { PrismaModule } from './database/prisma.module';
import { PrismaService } from './database/prisma.service';

/**
 *
 * Application modules
 *
 */
import { ConvertersModule } from './modules/converters/converters.module';
import { DataModule } from './modules/data/data.module';
import { OperationsModule } from './modules/operations/operations.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { WorkerModule } from './modules/worker/worker.module';

@Module({
  imports: [
    ConfigModule.forRoot({ validationSchema: conversionConfigSchema }),
    ObservabilityModule,
    // Owns the `conversion` schema: the operation history today; jobs,
    // job_events and the outbox with the asynchronous families.
    PrismaModule,
    // Drives the cleanup of unsaved results and interrupted operations.
    ScheduleModule.forRoot(),
    // A converter is useless without both: the database it records jobs in, and
    // the bucket it reads inputs from and writes results to.
    HealthModule.register({
      imports: [StorageModule],
      inject: [PrismaService, FileStorage],
      useFactory: (prisma: PrismaService, storage: FileStorage) => [
        databaseProbe(prisma),
        storageProbe(storage),
      ],
    }),
    StorageModule,
    /**
     *
     * Application modules
     *
     */
    ConvertersModule,
    // Conversion modules — each found by the registry, none listed in it.
    DataModule,
    OperationsModule,
    PipelineModule,
    WorkerModule,
  ],
})
export class AppModule {}
