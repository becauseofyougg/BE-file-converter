import {
  Controller,
  Get,
  HttpStatus,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';
import { ConfigService } from '../config/config.service';
import { BaseConfig } from '../config/config.types';

/** All the controller needs of the reply — Fastify's and Express's both fit. */
interface StatusReply {
  status(code: number): unknown;
}

@ApiTags('health')
@Controller('health')
// An orchestrator has no credentials; a probe that needed one would report the
// service unhealthy for the wrong reason.
@Public()
// A probe is not traffic — throttling it takes the service out of the load
// balancer exactly when it is under load.
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly configService: ConfigService<BaseConfig>,
  ) {}

  @ApiOperation({
    summary: 'Liveness and readiness',
    description:
      'Runs whatever probes the service registered — its database, the broker, object storage. With HEALTH_CHECK_ENABLED off it answers ok without checking anything, which is liveness only.',
  })
  @ApiResponse({ status: 200, description: 'Every probe is up.' })
  @ApiResponse({
    status: 503,
    description: 'At least one dependency is down; the body names which.',
  })
  @Get()
  @HealthCheck()
  async check(@Res({ passthrough: true }) reply: StatusReply) {
    const healthCheckEnabled = this.configService.getBoolean(
      'HEALTH_CHECK_ENABLED',
    );

    if (!healthCheckEnabled) {
      return this.healthService.getEmptyResponse();
    }

    try {
      return await this.healthService.checkHealth();
    } catch (error) {
      // Terminus reports "down" by throwing a 503 whose body names each
      // failing dependency. Left to propagate, the global exception filter
      // re-wraps it as `INTERNAL_ERROR` and the names are lost — which is the
      // one thing an operator opens `/health` to read. So it is answered here.
      if (error instanceof ServiceUnavailableException) {
        reply.status(HttpStatus.SERVICE_UNAVAILABLE);

        return error.getResponse();
      }

      throw error;
    }
  }
}
