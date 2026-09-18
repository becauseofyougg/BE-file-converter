import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';

import { ConfigService } from '@core/config/config.service';
import { S3Config } from './storage.config';
import { S3_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<S3Config>) =>
        new S3Client({
          endpoint: config.get('S3_ENDPOINT'),
          region: config.get('S3_REGION'),
          forcePathStyle: config.getBoolean('S3_FORCE_PATH_STYLE'),
          credentials: {
            accessKeyId: config.get('S3_ACCESS_KEY'),
            secretAccessKey: config.get('S3_SECRET_KEY'),
          },
        }),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
