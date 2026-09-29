import { Global, Injectable, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';

import { ConfigService } from '../config/config.service';
import { HealthModule } from './health.module';
import type { HealthProbe } from './health.probes';
import { HealthService } from './health.service';

/** Global in every app; the controller reads HEALTH_CHECK_ENABLED from it. */
@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: new ConfigService({ HEALTH_CHECK_ENABLED: 'true' }),
    },
  ],
  exports: [ConfigService],
})
class ConfigStubModule {}

@Injectable()
class FakeDatabase {
  up = true;
}

@Module({ providers: [FakeDatabase], exports: [FakeDatabase] })
class FakeDatabaseModule {}

const probeOf = (database: FakeDatabase): HealthProbe => ({
  name: 'database',
  check: () =>
    database.up ? Promise.resolve() : Promise.reject(new Error('refused')),
});

/**
 * Through real dependency injection, because that is where it broke: probes
 * declared as an `AppModule` provider were invisible to `HealthService`, which
 * silently ran none and reported `ok` on every service. A test that builds
 * the service by hand passes either way; this one does not.
 */
describe('HealthModule.register', () => {
  const compile = () =>
    Test.createTestingModule({
      imports: [
        ConfigStubModule,
        HealthModule.register({
          imports: [FakeDatabaseModule],
          inject: [FakeDatabase],
          useFactory: (database: FakeDatabase) => [probeOf(database)],
        }),
      ],
    }).compile();

  it('runs the probes it was given', async () => {
    const moduleRef = await compile();

    await expect(moduleRef.get(HealthService).checkHealth()).resolves.toEqual(
      expect.objectContaining({
        status: 'ok',
        details: { database: { status: 'up' } },
      }),
    );
  });

  it('reports a failing dependency, which is the point of having it', async () => {
    const moduleRef = await compile();
    moduleRef.get(FakeDatabase).up = false;
    jest
      .spyOn(moduleRef.get(HealthService)['logger'], 'error')
      .mockImplementation(() => undefined);

    await expect(moduleRef.get(HealthService).checkHealth()).rejects.toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          status: 'error',
          error: { database: { status: 'down', message: 'refused' } },
        }),
      }),
    );
  });

  /**
   * The old failure mode, pinned: `HealthService` somewhere the probes cannot
   * reach used to get an empty list and report `ok`. Now it does not boot.
   */
  it('refuses to build where no probes are registered, rather than reporting ok', async () => {
    await expect(
      Test.createTestingModule({
        imports: [TerminusModule],
        providers: [HealthService],
      }).compile(),
    ).rejects.toThrow(/HEALTH_PROBES/);
  });
});
