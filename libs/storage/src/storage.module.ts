import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';

import { ConfigService } from '@core/config/config.service';
import { FileStorage, type StorageDriverName } from './file-storage';
import { LocalFileStorage } from './local-file-storage';
import { S3FileStorage } from './s3-file-storage';
import type { StorageConfig } from './storage.config';
import { STORAGE_BACKENDS } from './storage.constants';
import { StorageResolver } from './storage-resolver';

/**
 * Every backend this deployment has the configuration for. Local is always
 * available — it needs only a directory. S3 is available when its endpoint and
 * credentials are set, which the config schema insists on when it is active.
 */
export function buildStorageBackends(
  config: ConfigService<StorageConfig>,
): Map<StorageDriverName, FileStorage> {
  const backends = new Map<StorageDriverName, FileStorage>([
    ['local', new LocalFileStorage(config.get('STORAGE_LOCAL_ROOT'))],
  ]);

  if (config.get('S3_ENDPOINT') && config.get('S3_ACCESS_KEY')) {
    backends.set(
      's3',
      new S3FileStorage(
        new S3Client({
          endpoint: config.get('S3_ENDPOINT'),
          region: config.get('S3_REGION'),
          forcePathStyle: config.getBoolean('S3_FORCE_PATH_STYLE'),
          credentials: {
            accessKeyId: config.get('S3_ACCESS_KEY'),
            secretAccessKey: config.get('S3_SECRET_KEY'),
          },
        }),
        config,
      ),
    );
  }

  return backends;
}

/**
 * `FileStorage` — the active driver, where new files go — and the resolver
 * that finds older files wherever they were written.
 */
@Module({
  providers: [
    {
      provide: STORAGE_BACKENDS,
      inject: [ConfigService],
      useFactory: buildStorageBackends,
    },
    {
      provide: FileStorage,
      inject: [STORAGE_BACKENDS, ConfigService],
      useFactory: (
        backends: Map<StorageDriverName, FileStorage>,
        config: ConfigService<StorageConfig>,
      ): FileStorage => {
        const driver = config.get('STORAGE_DRIVER') as StorageDriverName;
        const storage = backends.get(driver);

        if (!storage) {
          throw new Error(`STORAGE_DRIVER=${driver} is not configured`);
        }

        return storage;
      },
    },
    StorageResolver,
  ],
  exports: [FileStorage, StorageResolver],
})
export class StorageModule {}
