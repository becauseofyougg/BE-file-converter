import { Test, TestingModule } from '@nestjs/testing';
import {
  HealthCheckService,
  HealthIndicatorService,
  type HealthIndicatorResult,
} from '@nestjs/terminus';

import { HEALTH_PROBES, type HealthProbe } from './health.probes';
import { HealthService } from './health.service';

type Indicator = () => Promise<HealthIndicatorResult>;

describe('HealthService', () => {
  let healthCheckService: { check: jest.Mock };

  /**
   * Stands in for Terminus: keeps the indicator functions it was handed so a
   * test can run them and see what each probe reported.
   */
  let indicators: Indicator[];

  async function build(probes: HealthProbe[] = []): Promise<HealthService> {
    indicators = [];
    healthCheckService = {
      check: jest.fn().mockImplementation((given: Indicator[]) => {
        indicators = given;

        return Promise.resolve({ status: 'ok', details: {} });
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        HealthIndicatorService,
        { provide: HealthCheckService, useValue: healthCheckService },
        { provide: HEALTH_PROBES, useValue: probes },
      ],
    }).compile();

    return module.get(HealthService);
  }

  it('runs one indicator per registered probe', async () => {
    const service = await build([
      { name: 'database', check: jest.fn().mockResolvedValue(undefined) },
      { name: 'storage', check: jest.fn().mockResolvedValue(undefined) },
    ]);

    await service.checkHealth();

    expect(indicators).toHaveLength(2);
  });

  it('reports a working dependency as up, under its own name', async () => {
    const service = await build([
      { name: 'database', check: jest.fn().mockResolvedValue(undefined) },
    ]);

    await service.checkHealth();

    await expect(indicators[0]()).resolves.toEqual({
      database: { status: 'up' },
    });
  });

  /**
   * The endpoint has to keep answering when a dependency is down — a 500 from
   * the probe route tells an operator nothing about what is broken.
   */
  it('reports a failing dependency as down rather than throwing', async () => {
    const service = await build([
      {
        name: 'database',
        check: jest.fn().mockRejectedValue(new Error('connection refused')),
      },
    ]);

    await service.checkHealth();

    await expect(indicators[0]()).resolves.toEqual({
      database: { status: 'down', message: 'connection refused' },
    });
  });

  /**
   * `/health` is the one unauthenticated route on every service, and a
   * connection error routinely carries the whole URL, credentials included.
   */
  it('strips credentials out of a failure message', async () => {
    const service = await build([
      {
        name: 'rabbitmq',
        check: jest
          .fn()
          .mockRejectedValue(
            new Error('connect ECONNREFUSED amqp://admin:hunter2@rabbit:5672'),
          ),
      },
    ]);

    await service.checkHealth();
    const result = (await indicators[0]()) as {
      rabbitmq: { message: string };
    };

    expect(result.rabbitmq.message).not.toContain('hunter2');
    expect(result.rabbitmq.message).toContain('amqp://***@');
  });

  /**
   * A dependency that hangs must not hang the endpoint: an orchestrator reads
   * a probe that never answers as a dead process and kills the replica for the
   * wrong reason.
   */
  it('gives up on a probe that never settles', async () => {
    const service = await build([
      { name: 'slow', check: () => new Promise(() => undefined) },
    ]);

    await service.checkHealth();
    const settled = indicators[0]();

    jest.useFakeTimers();
    await Promise.resolve();
    jest.advanceTimersByTime(5_000);
    jest.useRealTimers();

    await expect(settled).resolves.toEqual({
      slow: { status: 'down', message: expect.stringContaining('Timed out') },
    });
  }, 10_000);

  it('reports ok with no probes at all, which is a liveness check', async () => {
    const service = await build();

    await service.checkHealth();

    expect(healthCheckService.check).toHaveBeenCalledWith([]);
  });

  it('short-circuits to ok when health checks are switched off', async () => {
    const service = await build([{ name: 'database', check: jest.fn() }]);

    expect(service.getEmptyResponse()).toEqual({ status: 'ok', details: {} });
    expect(healthCheckService.check).not.toHaveBeenCalled();
  });
});
