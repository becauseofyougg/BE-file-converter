import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Joi from 'joi';

import { ERROR_CODES } from '@contracts/errors/error-codes';
import { ConfigService } from '@core/config/config.service';
import { FileStorage } from './file-storage';
import { LocalFileStorage } from './local-file-storage';
import { S3FileStorage } from './s3-file-storage';
import { storageConfigSchema } from './storage.config';
import { buildStorageBackends, StorageModule } from './storage.module';
import { StorageResolver } from './storage-resolver';

const S3_ENV = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET_UPLOADS: 'uploads',
  S3_BUCKET_RESULTS: 'results',
};

const configWith = (values: Record<string, unknown>) =>
  new ConfigService<never>({
    STORAGE_LOCAL_ROOT: './.storage-test',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: true,
    ...values,
  });

describe('storage config', () => {
  const schema = Joi.object(storageConfigSchema);

  it('defaults to S3, and then insists on its credentials', () => {
    expect(schema.validate({}).error?.message).toMatch(/S3_ENDPOINT/);
    expect(schema.validate(S3_ENV).value.STORAGE_DRIVER).toBe('s3');
  });

  /** A local deployment must not be made to invent S3 credentials. */
  it('needs nothing but a directory for the local driver', () => {
    const { error, value } = schema.validate({ STORAGE_DRIVER: 'local' });

    expect(error).toBeUndefined();
    expect(value.STORAGE_LOCAL_ROOT).toBe('./.storage');
  });

  it('refuses a driver it has no implementation of', () => {
    expect(schema.validate({ STORAGE_DRIVER: 'ftp' }).error).toBeDefined();
  });
});

describe('buildStorageBackends', () => {
  it('always offers local storage', () => {
    const backends = buildStorageBackends(configWith({}));

    expect(backends.get('local')).toBeInstanceOf(LocalFileStorage);
    expect(backends.has('s3')).toBe(false);
  });

  /**
   * Configured alongside local, S3 stays readable — which is what keeps files
   * written before a switch reachable after it.
   */
  it('offers S3 too once it is configured', () => {
    const backends = buildStorageBackends(configWith(S3_ENV));

    expect(backends.get('s3')).toBeInstanceOf(S3FileStorage);
    expect(backends.get('local')).toBeInstanceOf(LocalFileStorage);
  });
});

describe('StorageModule', () => {
  const compile = (values: Record<string, unknown>) => {
    @Global()
    @Module({
      providers: [{ provide: ConfigService, useValue: configWith(values) }],
      exports: [ConfigService],
    })
    class ConfigStub {}

    return Test.createTestingModule({
      imports: [ConfigStub, StorageModule],
    }).compile();
  };

  it.each([
    ['local', LocalFileStorage],
    ['s3', S3FileStorage],
  ] as const)('injects the %s driver as FileStorage', async (driver, type) => {
    const moduleRef = await compile({ STORAGE_DRIVER: driver, ...S3_ENV });

    expect(moduleRef.get(FileStorage)).toBeInstanceOf(type);
  });

  it('refuses to start on a driver it cannot build', async () => {
    await expect(compile({ STORAGE_DRIVER: 's3' })).rejects.toThrow(
      /STORAGE_DRIVER=s3 is not configured/,
    );
  });

  describe('StorageResolver', () => {
    it('finds a file wherever it was written, by driver name', async () => {
      const moduleRef = await compile({ STORAGE_DRIVER: 'local', ...S3_ENV });
      const resolver = moduleRef.get(StorageResolver);

      expect(resolver.forDriver('s3')).toBeInstanceOf(S3FileStorage);
      expect(resolver.forDriver('local')).toBeInstanceOf(LocalFileStorage);
    });

    /** Better a clear 503 than a file the deployment silently cannot reach. */
    it('says so when the driver a file needs is not configured here', async () => {
      const moduleRef = await compile({ STORAGE_DRIVER: 'local' });

      expect(() => moduleRef.get(StorageResolver).forDriver('s3')).toThrow(
        expect.objectContaining({
          code: ERROR_CODES.STORAGE_UNAVAILABLE,
          httpStatus: 503,
        }),
      );
    });
  });
});
