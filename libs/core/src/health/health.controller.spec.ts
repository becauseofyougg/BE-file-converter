import { ServiceUnavailableException } from '@nestjs/common';
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
  let reply: { status: jest.Mock };

  beforeEach(async () => {
    healthCheckEnabled = true;
    reply = { status: jest.fn() };

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
    await controller.check(reply);

    expect(healthService.checkHealth).toHaveBeenCalled();
    expect(healthService.getEmptyResponse).not.toHaveBeenCalled();
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('short-circuits when health checks are disabled', async () => {
    healthCheckEnabled = false;

    await controller.check(reply);

    expect(healthService.getEmptyResponse).toHaveBeenCalled();
    expect(healthService.checkHealth).not.toHaveBeenCalled();
  });

  /**
   * Left to the global filter, this came back as `INTERNAL_ERROR` with the
   * failing dependency's name thrown away.
   */
  it('answers 503 with the names of what is down', async () => {
    const body = {
      status: 'error',
      info: { rabbitmq: { status: 'up' } },
      error: { storage: { status: 'down', message: 'refused' } },
      details: {},
    };
    healthService.checkHealth.mockRejectedValue(
      new ServiceUnavailableException(body),
    );

    await expect(controller.check(reply)).resolves.toEqual(body);
    expect(reply.status).toHaveBeenCalledWith(503);
  });

  it('lets anything else through to the exception filter', async () => {
    healthService.checkHealth.mockRejectedValue(new Error('bug'));

    await expect(controller.check(reply)).rejects.toThrow('bug');
    expect(reply.status).not.toHaveBeenCalled();
  });
});
