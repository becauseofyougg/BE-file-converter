import { Module } from '@nestjs/common';

import { ThrottlerModule } from '@core/throttler/throttler.module';
import { StorageModule } from '@storage/storage.module';
import { ProfileReadRateLimitGuard } from './profile-read-rate-limit.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // ThrottlerModule for `ThrottlerStorage`, which the per-viewer guard counts
  // in; StorageModule to presign the photo. An export is only visible to
  // modules that import it, so AppModule having imported either is not enough.
  imports: [ThrottlerModule, StorageModule],
  controllers: [UsersController],
  providers: [UsersService, ProfileReadRateLimitGuard],
})
export class UsersModule {}
