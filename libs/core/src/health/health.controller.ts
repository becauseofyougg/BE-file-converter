import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';
import { ConfigService } from '../config/config.service';
import { BaseConfig } from '../config/config.types';

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
  async check() {
    const healthCheckEnabled = this.configService.getBoolean(
      'HEALTH_CHECK_ENABLED',
    );

    if (!healthCheckEnabled) {
      return this.healthService.getEmptyResponse();
    }

    return this.healthService.checkHealth();
  }
}
