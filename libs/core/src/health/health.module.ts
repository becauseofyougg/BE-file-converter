import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * `/health` for every service.
 *
 * What it *checks* is up to the service: each one provides its own probes under
 * `HEALTH_PROBES` (see health.probes.ts), because only the service knows
 * whether it owns a database or talks to object storage. `TerminusModule` is
 * re-exported so an app can inject the indicators it needs when building them.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [TerminusModule],
})
export class HealthModule {}
