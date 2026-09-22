import { Global, Module } from '@nestjs/common';

import { AuthGuardsModule } from '../auth/auth-guards.module';
import { RbacAdminController } from './rbac-admin.controller';
import { RbacConfigCache } from './rbac-config.cache';
import { RbacEventsController } from './rbac-events.controller';
import { RbacGuard } from './rbac.guard';

/**
 * Global because `RbacGuard` is registered application-wide and every feature
 * module's routes are decided by the same cache.
 */
@Global()
@Module({
  imports: [AuthGuardsModule],
  controllers: [RbacAdminController, RbacEventsController],
  providers: [RbacConfigCache, RbacGuard],
  exports: [RbacConfigCache, RbacGuard],
})
export class RbacModule {}
