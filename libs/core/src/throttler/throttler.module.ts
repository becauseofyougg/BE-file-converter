import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottlerModule as NestThrottlerModule,
} from '@nestjs/throttler';

import { ConfigService } from '../config/config.service';
import { ThrottlerConfig } from '../config/config.types';

@Module({
  imports: [
    NestThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ThrottlerConfig>) => [
        {
          ttl: config.getNumber('THROTTLE_GLOBAL_TTL'),
          limit: config.getNumber('THROTTLE_GLOBAL_LIMIT'),
        },
      ],
    }),
  ],
  providers: [
    // Without this the module configures a limit that nothing enforces.
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
  exports: [NestThrottlerModule],
})
export class ThrottlerModule {}
