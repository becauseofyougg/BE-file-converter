import { Module } from '@nestjs/common';

import { RbacModule } from '../rbac/rbac.module';
import { ProfileService } from './profile.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // For the RBAC config and the role names: reading a profile needs to answer
  // "may this viewer see someone else's" and, for self, "which roles do they
  // hold" — docs/USER-PROFILE.md §3.
  imports: [RbacModule],
  controllers: [UsersController],
  providers: [UsersService, ProfileService],
  exports: [UsersService, ProfileService],
})
export class UsersModule {}
