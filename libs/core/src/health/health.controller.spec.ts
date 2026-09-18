import { Test, TestingModule } from '@nestjs/testing';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { ConfigService } from '../config/config.service';

describe('HealthController', () => {
  let controller: HealthController;
  let healthService: jest.Mocked<
    Pick<HealthService, 'checkHealth' | 'getEmptyResponse'>
  >;
  let healthCheckEnabled: boolean;

  beforeEach(async () => {
    healthCheckEnabled = true;

    healthService = {
      checkHealth: jest.fn().mockResolvedValue({ status: 'ok', details: {} }),
      getEmptyResponse: jest
        .fn()
        .mockReturnValue({ status: 'ok', details: {} }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthService, useValue: healthService },
        {
          provide: ConfigService,
          useValue: { getBoolean: () => healthCheckEnabled },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('runs the indicators when health checks are enabled', async () => {
    await controller.check();

    expect(healthService.checkHealth).toHaveBeenCalled();
    expect(healthService.getEmptyResponse).not.toHaveBeenCalled();
  });

  it('short-circuits when health checks are disabled', async () => {
    healthCheckEnabled = false;

    await controller.check();

    expect(healthService.getEmptyResponse).toHaveBeenCalled();
    expect(healthService.checkHealth).not.toHaveBeenCalled();
  });
});
