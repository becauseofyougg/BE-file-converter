import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { ConverterRegistry } from './converter-registry';
import { WorkerRunner } from './worker-runner';

/**
 * The machinery every conversion module shares: the registry that finds them,
 * and the runner that gives each conversion its own thread. The modules
 * themselves live beside this one and are imported by `AppModule`.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [ConverterRegistry, WorkerRunner],
  exports: [ConverterRegistry, WorkerRunner],
})
export class ConvertersModule {}
