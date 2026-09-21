import { Global, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { ClsModule } from 'nestjs-cls';

import { PrismaService } from './prisma.service';

/**
 * The database connection plus the ambient-transaction machinery.
 *
 * Prisma has no ambient transaction of its own: `$transaction(cb)` hands the
 * callback a separate client, and every query that should join the
 * transaction has to be issued through *that* client. Threading it by hand
 * would put a `tx` parameter on every repository method and every call site.
 *
 * `nestjs-cls` keeps it in AsyncLocalStorage instead, so `@Transactional()`
 * marks the boundary and `txHost.tx` inside any service resolves to the
 * ambient transaction — or to the base client when there is none.
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      // The RPC handlers are the entry points, and they are not HTTP, so the
      // middleware-based setup does not apply — the plugin opens the context.
      global: true,
      plugins: [
        new ClsPluginTransactional({
          imports: [PrismaModule],
          adapter: new TransactionalAdapterPrisma({
            prismaInjectionToken: PrismaService,
          }),
        }),
      ],
    }),
  ],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
