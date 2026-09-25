import { Module } from '@nestjs/common';

import { ThrottlerModule } from '@core/throttler/throttler.module';
import { StorageModule } from '@storage/storage.module';
import { RbacModule } from '../rbac/rbac.module';
import { AdminUsersController } from './admin-users.controller';
import { ProfileReadRateLimitGuard } from './profile-read-rate-limit.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // ThrottlerModule for `ThrottlerStorage`, which the per-viewer guard counts
  // in; StorageModule to presign the photo. An export is only visible to
  // modules that import it, so AppModule having imported either is not enough.
  // RbacModule for the cached config the route-level `users@list` check reads.
  imports: [ThrottlerModule, StorageModule, RbacModule],
  controllers: [UsersController, AdminUsersController],
  providers: [UsersService, ProfileReadRateLimitGuard],
})
export class UsersModule {}
