import { Controller, Get } from '@nestjs/common';
import { HealthCheck } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { HealthService } from './health.service';
import { ConfigService } from '../config/config.service';
import { BaseConfig } from '../config/config.types';

@Controller('health')
// A probe is not traffic — throttling it takes the service out of the load
// balancer exactly when it is under load.
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly configService: ConfigService<BaseConfig>,
  ) {}

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
