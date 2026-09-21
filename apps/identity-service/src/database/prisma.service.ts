import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma-clients/identity';

import { ConfigService } from '@core/config/config.service';
import { IdentityConfig } from '../config/identity.config';

/**
 * The `identity` database connection. Owns its schema; no other service reads
 * it, and this is the only class that holds a client for it.
 *
 * Connecting in `onModuleInit` rather than lazily means a bad URL or an
 * unreachable database fails the boot, in the same way an invalid environment
 * variable does — rather than surfacing on the first request at 3 a.m.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<IdentityConfig>) {
    super({
      datasources: { db: { url: config.get('DATABASE_URL') } },
      log: config.getBoolean('DATABASE_LOG_QUERIES')
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log({ event: 'database.connected' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
