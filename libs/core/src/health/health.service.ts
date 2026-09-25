import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  HealthCheckService,
  HealthIndicatorService,
  type HealthCheckResult,
} from '@nestjs/terminus';

import {
  HEALTH_PROBES,
  withProbeTimeout,
  type HealthProbe,
} from './health.probes';

/**
 * Runs whatever probes the service registered — NON-FUNCTIONAL-REQUIREMENTS.md §2.
 *
 * A service with no probes reports `ok` and means only "the process is up and
 * answering", which is a liveness check. A service that registers its database
 * and its broker reports on those, which is a readiness check — the difference
 * between a replica that is taken out of the load balancer when Postgres dies
 * and one that keeps receiving traffic it cannot serve.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @Optional()
    @Inject(HEALTH_PROBES)
    private readonly probes: HealthProbe[] = [],
  ) {}

  getEmptyResponse(): HealthCheckResult {
    return {
      status: 'ok',
      details: {},
    };
  }

  checkHealth(): Promise<HealthCheckResult> {
    return this.healthCheckService.check(
      this.probes.map((probe) => () => this.run(probe)),
    );
  }

  /**
   * Every failure is caught and turned into a `down` entry rather than thrown.
   * One unreachable dependency should make `/health` say which one, not make
   * the endpoint itself error — a 500 from the probe route tells an operator
   * nothing about what is broken.
   */
  private async run(probe: HealthProbe) {
    const session = this.indicator.check(probe.name);

    try {
      await withProbeTimeout(probe.check());

      return session.up();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';

      this.logger.error({
        event: 'health.probe.failed',
        probe: probe.name,
        reason: message,
      });

      // The message, not the error: a connection failure can carry the whole
      // URL, credentials included, and `/health` is the one unauthenticated
      // route on the service.
      return session.down({ message: redact(message) });
    }
  }
}

/** Strips anything shaped like `scheme://user:password@host` from a message. */
function redact(message: string): string {
  return message.replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s]*@/gi, '$1://***@');
}
