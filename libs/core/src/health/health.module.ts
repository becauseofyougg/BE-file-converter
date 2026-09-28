import {
  type DynamicModule,
  type FactoryProvider,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { HEALTH_PROBES, type HealthProbe } from './health.probes';
import { HealthService } from './health.service';

export interface HealthProbesOptions {
  /** Modules the probes' dependencies come from, if they are not global. */
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory: (...dependencies: never[]) => HealthProbe[];
}

/**
 * `/health` for every service, checking what that service says to check.
 *
 * The probes are registered *here*, through `register`, and not as a provider
 * of the app module. That is not style: a provider is visible only inside its
 * own module, so a `HEALTH_PROBES` declared in `AppModule` was invisible to
 * `HealthService`, which then ran nothing and reported `ok` on every service —
 * a readiness check that could not fail. Unit tests, which construct the
 * service by hand, could not see it; only a running stack did.
 */
@Module({})
export class HealthModule {
  static register(options: HealthProbesOptions): DynamicModule {
    return {
      module: HealthModule,
      imports: [TerminusModule, ...(options.imports ?? [])],
      controllers: [HealthController],
      providers: [
        HealthService,
        {
          provide: HEALTH_PROBES,
          inject: options.inject ?? [],
          useFactory: options.useFactory as (
            ...dependencies: unknown[]
          ) => HealthProbe[],
        },
      ],
      exports: [TerminusModule],
    };
  }
}
