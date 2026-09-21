import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService } from '@nestjs/terminus';

import { HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;
  let healthCheckService: { check: jest.Mock };

  beforeEach(async () => {
    healthCheckService = {
      check: jest.fn().mockResolvedValue({ status: 'ok', details: {} }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: HealthCheckService, useValue: healthCheckService },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('delegates to Terminus with the registered indicators', async () => {
    await service.checkHealth();

    expect(healthCheckService.check).toHaveBeenCalledWith([]);
  });

  it('returns an ok response without touching dependencies when disabled', () => {
    expect(service.getEmptyResponse()).toEqual({ status: 'ok', details: {} });
    expect(healthCheckService.check).not.toHaveBeenCalled();
  });
});
